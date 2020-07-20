'use strict';

const request = require('request-promise-native');
const xml2js  = require('xml2js');
const AWS     = require('aws-sdk');
const s3      = new AWS.S3();

const PC_BUCKET = process.env.PC_BUCKET;

module.exports.handler = async (event = {}) => {
  //console.log("Event: ", JSON.stringify(event, null, 2));

  try {
    const { Records = [] } = event;
    
    if(Records.length > 0) {
      for(const record of Records) {
        const { body = "" } = record;
        const sitemapRecord = JSON.parse(body);
        const { loc } = sitemapRecord;

        const res = await fetchBill(loc);
        await updateBill(res);
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

async function fetchBill(loc) {
  if(!loc) throw { statusCode: 400, message: "Invalid record: no loc" };

  try {
    const res = await request(loc);
    return res;
  } catch(err) {
    console.error(err);
    throw { statusCode: 404, message: "Bill not found" };
  }
}

async function updateBill(res) {
  const { bill } = await xml2js.parseStringPromise(res, { explicitArray: false, explicitRoot: false });
  const { congress, billType, billNumber } = bill;
  const file = Buffer.from(res);
  if(file) await s3.upload({ Bucket: PC_BUCKET, Key: `congress/${congress}/${billType.toLowerCase()}/${billNumber}.xml`, Body: file }).promise();
  else console.error("NO BILL");
}
