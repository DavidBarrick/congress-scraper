'use strict';

const request = require('request-promise-native');
const xml2js  = require('xml2js');
const AWS     = require('aws-sdk');
const s3      = new AWS.S3();
const sqs     = new AWS.SQS();

const GOVINFO_BASE_URL = "https://www.govinfo.gov/";
const BULKDATA_SITEMAPINDEX_PATTERN = GOVINFO_BASE_URL + "sitemap/bulkdata/BILLSTATUS/sitemapindex.xml";

const CURRENT_CONGRESS = "116";
const PC_BUCKET = process.env.PC_BUCKET;
const PC_BILL_TYPE_UPDATE_QUEUE_URL = process.env.PC_BILL_TYPE_UPDATE_QUEUE_URL;

module.exports.handler = async (event = {}) => {
  console.log("Event: ", JSON.stringify(event, null, 2));

  try {
    const { id } = event;
    if(!id) throw { statusCode: 400, message: "UpdateID required" };
    
    const { sitemap: serverSitemap, json: serverSitemapJSON } = await fetchServerSitemap();
    const localSitemapJSON                                    = await fetchLocalSitemap();

    const serverIndexes = fetchValidIndexes(serverSitemapJSON);
    const localIndexes  = fetchValidIndexes(localSitemapJSON);

    await processIndexUpdates(serverIndexes, localIndexes, id);
    await updateSitemap(serverSitemap);

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true }, null, 2),
    };
  } catch(err) {
    console.error(err);
    return {
      statusCode: err.statusCode || 500,
      body: JSON.stringify({ message: err.message }, null, 2),
    };
  }
};

async function fetchServerSitemap() {
  try {
    const sitemap = await request(BULKDATA_SITEMAPINDEX_PATTERN);

    const siteMapJSON = await xml2js.parseStringPromise(sitemap, { explicitRoot: false, ignoreAttrs: true });
    return { sitemap, json: siteMapJSON };
  } catch(err) {
    throw { statusCode: 404, message: "Server sitemap not found" };
  }
}

async function fetchLocalSitemap() {
  const key = `congress/${CURRENT_CONGRESS}/sitemap.xml`;

  try {
    const { Body } = await s3.getObject({ Bucket: PC_BUCKET, Key: key }).promise();
    if(Body) {
      const siteMapJSON = await xml2js.parseStringPromise(Body.toString(), { explicitRoot: false, ignoreAttrs: true });
      return siteMapJSON;
    }
  } catch(err) {
    if(err.statusCode !== 404) throw err;
  }
}

function fetchValidIndexes(sitemap = {}) {
  const { sitemap: indexes = [] } = sitemap;

  const re = new RegExp(`https:\\/\\/www\\.govinfo\\.gov\\/sitemap\\/bulkdata\\/BILLSTATUS\\/${CURRENT_CONGRESS}(\\w+)\\/sitemap\\.xml`);
  const validIndexes = indexes.filter(index => index.loc && index.loc.length > 0).filter(index => re.test(index.loc[0]));
  return validIndexes.map(index => { return transformIndex(index, re) });
}

function transformIndex(index, re) {
  const { loc: locNode, lastmod: lastmodNode } = index;
  const loc = locNode.pop();
  const lastmod = lastmodNode.pop();
  const matches = loc.match(re);
  if(matches.length >= 2) return { loc, lastmod, congress: CURRENT_CONGRESS, bill_type: matches[1] };

  return { loc, lastmod };
}

async function processIndexUpdates(server = [], local = [], updateId) {
  for(const serverIndex of server) {
    const localIndex = local.filter(index => index.loc === serverIndex.loc).pop();
    if(!localIndex || localIndex.lastmod !== serverIndex.lastmod) await queueIndexUpdate(serverIndex, updateId);
  }
}

async function queueIndexUpdate(index = {}, updateId) {
  console.log("Found Update: ", index.loc);
  const params = {
    MessageBody: JSON.stringify({ updateId, ...index }),
    DelaySeconds: 0,
    QueueUrl: PC_BILL_TYPE_UPDATE_QUEUE_URL
  };

  return sqs.sendMessage(params).promise();
}

async function updateSitemap(sitemap) {
  const file = Buffer.from(sitemap);
  if(file) await s3.upload({ Bucket: PC_BUCKET, Key: `congress/${CURRENT_CONGRESS}/sitemap.xml`, Body: file }).promise();
}
