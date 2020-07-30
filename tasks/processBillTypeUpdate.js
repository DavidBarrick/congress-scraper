'use strict';

const request = require('request-promise-native');
const xml2js  = require('xml2js');
const AWS     = require('aws-sdk');
const crypto  = require('crypto');
const s3      = new AWS.S3();
const sqs     = new AWS.SQS();

//const GOVINFO_BASE_URL = "https://www.govinfo.gov/";
//const BULKDATA_SITEMAPINDEX_PATTERN = GOVINFO_BASE_URL + "sitemap/bulkdata/BILLSTATUS/sitemapindex.xml";

const BILL_TYPES = [
  "hres",
  "hconres",
  "hr",
  "hjres",
  "sres",
  "sjres",
  "s",
  "sconres"
];

const PC_BUCKET = process.env.PC_BUCKET;
const PC_BILL_UPDATE_QUEUE_URL = process.env.PC_BILL_UPDATE_QUEUE_URL;

module.exports.handler = async (event = {}) => {
  //console.log("Event: ", JSON.stringify(event, null, 2));

  try {
    const { Records = [] } = event;
    
    if(Records.length > 0) {
      //Should only be 1 record in batch, but process all in case of config change
      for(const record of Records) {
        const { body = "" } = record;
        const sitemapRecord = JSON.parse(body);
        const { loc, congress, bill_type } = sitemapRecord;
        validateRecord(congress, bill_type);

        const { sitemap: serverSitemap, json: serverSitemapJSON } = await fetchServerSitemap(loc);
        const localSitemapJSON = await fetchLocalSitemap(congress, bill_type);
    
        const serverIndexes = fetchValidIndexes(congress, bill_type, serverSitemapJSON);
        const localIndexes = fetchValidIndexes(congress, bill_type, localSitemapJSON);
    
        await processIndexUpdates(serverIndexes, localIndexes);
        await updateSitemap(congress, bill_type, serverSitemap);
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true }, null, 2),
    };
  } catch(err) {
    console.error(err);
    return {
      statusCode: err.statusCode || 500,
      body: JSON.stringify({ message: err.message || "An unknown error occured" }, null, 2),
    };
  }
};

function validateRecord(congress, bill_type) {
  if(!congress || !bill_type || BILL_TYPES.indexOf(bill_type) === -1) throw { statusCode: 400, message: "Invalid record: " + bill_type };
}

async function fetchServerSitemap(loc) {
  if(!loc) throw { statusCode: 400, message: "Invalid record: no loc" };

  const sitemap = await request(loc);

  const siteMapJSON = await xml2js.parseStringPromise(sitemap, { explicitRoot: false, ignoreAttrs: true });
  return { sitemap, json: siteMapJSON };
}

async function fetchLocalSitemap(congress, bill_type) {
  if(!congress || !bill_type) throw { statusCode: 400, message: "Invalid record: no congress or bill type" };

  const key = `congress/${congress}/${bill_type}/sitemap.xml`;
  try {
    const { Body } = await s3.getObject({ Bucket: PC_BUCKET, Key: key }).promise();
    if(Body) {
      const siteIndexJSON = await xml2js.parseStringPromise(Body.toString(), { explicitRoot: false, ignoreAttrs: true });
      return siteIndexJSON;
    }
  } catch(err) {
    return;
  }
}

function fetchValidIndexes(congress, bill_type, sitemap = {}) {
  const { url: indexes = [] } = sitemap;
  
  const re = new RegExp( `https:\\/\\/www\\.govinfo\\.gov\\/bulkdata\\/BILLSTATUS\\/${congress}/${bill_type}/BILLSTATUS-${congress}${bill_type}([0-9]+).xml`);
  const validIndexes = indexes.filter(index => index.loc && index.loc.length > 0).filter(index => re.test(index.loc[0]));
  return validIndexes.map(index => { return transformIndex(index, re, congress, bill_type) });
}

function transformIndex(index, re, congress, bill_type) {
  const { loc: locNode, lastmod: lastmodNode } = index;
  const loc = locNode.pop();
  const lastmod = lastmodNode.pop();
  const matches = loc.match(re);
  if(matches.length >= 2) return { loc, lastmod, congress, bill_type, number: matches[1] };

  return { loc, lastmod };
}

async function processIndexUpdates(server = [], local = []) {
  const updates = [];
  for(const serverIndex of server) {
    const localIndex = local.filter(index => index.loc === serverIndex.loc).pop();
    if(!localIndex || localIndex.lastmod !== serverIndex.lastmod) updates.push(serverIndex);
  }

  if(updates.length > 0) return queueIndexUpdates(updates);
}

async function queueIndexUpdates(keys = [], batch = 0) {
  const entries = keys.slice(batch * 10, batch * 10 + 10).map(createSQSEntry);

  if(entries.length > 0) {
    const params = {
      Entries: entries,
      QueueUrl: PC_BILL_UPDATE_QUEUE_URL
    };
  
    await sqs.sendMessageBatch(params).promise();
    if(batch * 10 + 10 < keys.length) return queueIndexUpdates(keys, batch + 1);
  }
}

function createSQSEntry(index) {
  const id = crypto.createHash('md5').update(index.loc).digest("hex");

  return {
    Id: id,
    MessageBody: JSON.stringify(index)
  }
}

async function updateSitemap(congress, bill_type, sitemap) {
  const file = Buffer.from(sitemap);
  if(file) await s3.upload({ Bucket: PC_BUCKET, Key: `congress/${congress}/${bill_type}/sitemap.xml`, Body: file }).promise();
}
