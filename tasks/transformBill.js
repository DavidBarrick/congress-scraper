'use strict';

const xml2js = require('xml2js');
const AWS    = require('aws-sdk');
const s3     = new AWS.S3();
const TurndownService = require('turndown');
const turndownService = new TurndownService();

const GOVINFO_BASE_URL  = "https://www.govinfo.gov/";
const BULKDATA_BASE_URL = GOVINFO_BASE_URL + "bulkdata/";

/*
S3 EVENT SAMPLE
{  
   "Records":[  
      {  
         "eventVersion":"2.2",
         "eventSource":"aws:s3",
         "awsRegion":"us-west-2",
         "eventTime":The time, in ISO-8601 format, for example, 1970-01-01T00:00:00.000Z, when Amazon S3 finished processing the request,
         "eventName":"event-type",
         "userIdentity":{  
            "principalId":"Amazon-customer-ID-of-the-user-who-caused-the-event"
         },
         "requestParameters":{  
            "sourceIPAddress":"ip-address-where-request-came-from"
         },
         "responseElements":{  
            "x-amz-request-id":"Amazon S3 generated request ID",
            "x-amz-id-2":"Amazon S3 host that processed the request"
         },
         "s3":{  
            "s3SchemaVersion":"1.0",
            "configurationId":"ID found in the bucket notification configuration",
            "bucket":{  
               "name":"bucket-name",
               "ownerIdentity":{  
                  "principalId":"Amazon-customer-ID-of-the-bucket-owner"
               },
               "arn":"bucket-ARN"
            },
            "object":{  
               "key":"object-key",
               "size":object-size,
               "eTag":"object eTag",
               "versionId":"object version if bucket is versioning-enabled, otherwise null",
               "sequencer": "a string representation of a hexadecimal value used to determine event sequence, 
                   only used with PUTs and DELETEs"
            }
         },
         "glacierEventData": {
            "restoreEventData": {
               "lifecycleRestorationExpiryTime": "The time, in ISO-8601 format, for example, 1970-01-01T00:00:00.000Z, of Restore Expiry",
               "lifecycleRestoreStorageClass": "Source storage class for restore"
            }
         }
      }
   ]
}
*/

module.exports.handler = async (event = {}) => {
  //console.log("Event: ", JSON.stringify(event, null, 2));

  try {
    const { Records = [] } = event;
    
    if(Records.length > 0) {
      for(const record of Records) {
         const { s3 = {} } = record;
         const { bucket: { name: bucketName }, object: { key: objectKey } } = s3;
         if(isValidKey(objectKey)) {
            const govInfoBill = await fetchBill(bucketName, objectKey);
            const billJSON = await transformGovInfoBill(govInfoBill);
            await createBillJSON(bucketName, billJSON);
         }
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

function isValidKey(key) {
   return key && !key.endsWith("sitemap.xml");
}

function build_bill_id(bill_type, bill_number, congress) {
  return `${bill_type}${bill_number}-${congress}`;
}

function billstatus_url_for(bill_id) {
    const { congress, bill_type, bill_number} = split_bill_id(bill_id);
    return `${BULKDATA_BASE_URL}BILLSTATUS/${congress}/${bill_type}/BILLSTATUS-${congress}${bill_type}${bill_number}.xml`;
}

function split_bill_id(bill_id) {
   try {
      const groups = bill_id.match(/^([a-z]+)(\d+)-(\d+)$/);
      const bill_type = groups[1];
      const bill_number = groups[2];
      const congress = groups[3];
      return { bill_number, bill_type, congress };
   } catch(err) {
      throw { statusCode: 404, message: "Invalid bill id: " + bill_id };
   }
}

function sponsor_for(sponsorsNode = {}) {
   const { item: sponsor = [] } = sponsorsNode;
   if(sponsor.length === 0) return;

   const { bioguideId: id, state, firstName, middleName, lastName, district, party } = transformNode(sponsor.pop());

   return {
      name: `${firstName} ${lastName}`,
      state: state,
      district: district, // missing for senators
      party: party,
      id: id
   }
}

function cosponsors_for(cosponsorsNode = {}) {
   const { item: cosponsors = [] } = cosponsorsNode;
   if(cosponsors.length === 0) return [];

   function build_dict(item) {
      const { sponsorshipDate, sponsorshipWithdrawnDate, isOriginalCosponsor } = transformNode(item);
      let cosponsor = sponsor_for({ item: [item] });
      cosponsor.sponsored_at = sponsorshipDate;
      cosponsor.withdrawn_at = sponsorshipWithdrawnDate;
      cosponsor.isOriginalCosponsor = isOriginalCosponsor === 'True';

      return cosponsor;
   }

   const retval = cosponsors.map(build_dict);

   // TODO: Can remove. Sort like the old THOMAS order to make diffs easier.
   retval.sort((a,b) => { return a.name - b.name });
   return retval;
}

function summary_for(summariesNode = {}) {
   const { billSummaries = [] } = summariesNode;
   if(billSummaries.length === 0) return;
   var { item: summaries = [] } = billSummaries.pop();
   if(summaries.length === 0) return;

   summaries = summaries.map(transformNode);
   // Take the most recent summary, by looking at the lexicographically last updateDate.
   summaries.sort((a,b) => { return (new Date(a.updateDate)) - (new Date(b.updateDate)) });
   const { updateDate, name, text } = summaries.pop();

   return {
      "date": updateDate,
      "as": name,
      "text": turndownService.turndown(text)
   }
}

function latest_status(actions, introduced_at) {
   var status = "INTRODUCED";
   var status_date = introduced_at;

   const latestAction = actions.pop();
   if(latestAction) {
      status = latestAction["status"];
      status_date = latestAction["acted_at"];
   }

   return { status, status_date };
}

function strip_tags(text) {
   //# Preserve paragraph breaks. Convert closing p tags (and surrounding whitespace) into two newlines. Strip trailing whitespace
   text = text.replace(/<[^>]p>/gi, "\n\n").trim();

   //# naive stripping of tags, should work okay in this limited context
   text = text.replace(/<[^>]+>/gi, "");

   //# compress and strip whitespace artifacts, except for the paragraph breaks
   text = text.replace(/[ \t\r\f\v]{2,}/, " ").trim();

   //# Replace HTML entities with characters.
   //TODO find alternative for this
   //text = decodeURIComponent(text);

   return text;
}

function transformNode(res) {
   for(const key in res) {
      if(Array.isArray(res[key]) && res[key].length === 1) res[key] = res[key].pop();
      else transformNode();
   }

   return res;
}

function current_title_for(titles, title_type) {
   const current_title = titles.filter(item => item.type === title_type).pop();
   if(current_title) return current_title.title;
}

function titles_for(titlesNode = {}) {
   const { item: titles = [] } = titlesNode;
   if(titles.length === 0) return [];

   function build_dict(item) {
      const { titleType, title } = transformNode(item);
      var full_type = titleType;
      var is_for_portion = false;
      var title_type;
      var state;

      // "Official Titles as Introduced", "Short Titles on Conference report"
      const splits = full_type.includes(" as ") ? full_type.split(" as ") : full_type.split(" on ");
      if (splits.length == 2) {
         var title_type = splits[0]
         var state = splits[1];

         if (state.endsWith(" for portions of this bill")) {
            is_for_portion = true;
            state = state.replace(" for portions of this bill" ,"");
         }

         state = state.replace(":", "").toLowerCase();
      } else {
         title_type = full_type;
      }

      if (title_type.includes("Popular Title")) {
         title_type = "popular";
      } else if (title_type.includes("Short Title")) { 
         title_type = "short";
      } else if (title_type.includes("Official Title")) {
         title_type = "official";
      } else if(title_type.includes("Display Title")) {
         title_type = "display";
      } else if (title_type == "Non-bill-report") {
         // TODO: What kind of title is this? Maybe assign
         // a better title_type code once we know.
         title_type = "nonbillreport";
      } else {
         throw { statusCode: 400, message: "Unknown title type: " + title_type };
      }

      return {
         'title': title,
         'is_for_portion': is_for_portion,
         'as': state,
         'type': title_type
      }
   }

   return titles.map(build_dict);
}


function actions_for(actionsNode, bill_id, title) {
   const { item = [] } = actionsNode;
   if(item.length === 0) return [];
   const actions = item.map(transformNode);

   var closure = { };
   function keep_action(item) {
      if (!item['text'] || item["text"] === "") return false;
            
      var keep = true;
      if (closure['prev']) {
         if (item['sourceSystem']['code'] == "9") {
            /*# Date must match previous action..
            # If both this and previous have a time, the times must match.
            # The text must approximately match. Sometimes the LOC text has a prefix
            #   and different whitespace. And they may drop references -- so we'll
            # use our action_for helper function to drop references from both
            # prior to the string comparison.*/
            if ((item['actionDate'] == closure["prev"]["actionDate"]) &&
               ((item['actionTime'] == closure["prev"]["actionTime"]) || !item['actionTime'] || !closure["prev"]["actionTime"]) &&
               (action_for(item)['text'].replace(" ", "").endsWith(action_for(closure["prev"])['text'].replace(" ", "")))) keep = false;
         }
      }

      closure['prev'] = item;
      return keep;
   }

   function build_dict(item, closure) {
      var action_dict = action_for(item)
      var { action: extra_action_info, stauts: new_status } = parse_bill_action(action_dict, closure['prev_status'], bill_id, title);

      //# only change/reflect status change if there was one
      if (new_status) {
         action_dict['status'] = new_status;
         closure['prev_status'] = new_status;
      }

      //# add additional parsed fields
      if (extra_action_info) {
         Object.assign(action_dict, extra_action_info);
      }

      return action_dict;
   }

   closure = {
      "prev_status": "INTRODUCED",
   }

   return actions.filter(keep_action).reverse().map(build_dict);
}

//# clean text, pull out the action type, any other associated metadata with an action
function action_for(item, bill_id, title) {
   //# acted_at
   var { actionTime, actionDate, actionCode, text = "" } = transformNode(item);
   const acted_at = new Date(`${actionDate}${actionTime ? `T${actionTime}` : ""}`).toISOString();

   //# strip out links
   text = text.replace(/r<\/?[Aa]( \S.*?)?>/g, "");

   const action_dict = {
      'acted_at': acted_at,
      'action_code': actionCode,
      'type': 'action', //# replaced by parse_bill_action if a regex matches 
      'text': text,
   }

   return action_dict;
}

function parse_bill_action(action_dict, prev_status = "", bill_id, title = "") {
   const { bill_type, number, congress } = split_bill_id(bill_id);
   var { text } = action_dict;

   const action = { type: "action" };
   var vote_type;
   var status;
   var new_status;
   //# If a line starts with an amendment number, this action is on the amendment and cannot
   //# be parsed yet.
   if ((/^(H|S)\.Amdt\.(\d+)/i).test(text)) {
      //# Process actions specific to amendments separately.
      return { }
   }

   //House Vote
   var matchString = "\("
      + [
          "On passage",
          "Passed House",
          "Two-thirds of the Members present having voted in the affirmative the bill is passed,\?",
          "On motion to suspend the rules and pass the \(\?\:bill\|resolution\)",
          "On agreeing to the \(\?\:resolution\|conference report\)",
          "On motion to suspend the rules and agree to the \(\?\:resolution\|conference report\)",
          "House Agreed to Senate Amendments.\*\?",
          "On motion \(\?\:that \)\?the House \(\?\:suspend the rules and \)\?\(\?\:agree\(\?\: with an amendment\)\? to\|concur in\) the Senate amendments\?\(\?\: to the House amendments\?\| to the Senate amendments\?\)\*",
      ].join("\|")
      + "\)"
      + "\(, the objections of the President to the contrary notwithstanding.\?\)\?"
      + "\(, as amended\| \\(Amended\\)\)\?"
      + "\\.\? \(Passed\|Failed\|Agreed to\|Rejected\)\?" //# hr1625-115 has a stray period here
      + " \?\(by voice vote\|without objection\|by \(the Yeas and Nays\?\|Yea-Nay Vote\|recorded vote\)"
      + "\(\:\? \\(2/3 required\\)\)\?\: \(\\d\+ \?\- \?\\d\+\(, \\d\+ Present\)\? \[ \\)\]\*\)\?\\(\(Roll no\\.\|Record Vote No\:\) \\d\+\\)\)";
   var re = new RegExp(matchString,"i");
   var m = text.replace(", the Passed", ", Passed").match(re);
   if(m) {
      var motion = m[1];
      var is_override = m[2];
      var as_amended = m[3];
      var pass_fail = m[4];
      var how = m[5];

      if ((/Passed House|House Agreed to/i).test(motion)) pass_fail = 'pass';
      else if ((/(ayes|yeas) had prevailed/i).test(text)) pass_fail = 'pass';
      else if ((/Pass|Agreed/i).test(pass_fail)) pass_fail = 'pass';    
      else pass_fail = 'fail';

      if ((/Two-thirds of the Members present/i).test(motion)) is_override = true;
            
      if (is_override) vote_type = "override"
      else if ((/(agree (with an amendment )?to|concur in) the Senate amendment/i).test(text)) vote_type = "pingpong";      
      else if ((/conference report/i).test(text)) vote_type = "conference"
      else if (bill_type == "hr") vote_type = "vote"      
      else vote_type = "vote2"
      
      var roll;
      m = how.match(/\((Roll no\.|Record Vote No:) (\d+)\)/i);
      if(m) {
         how = "roll"  //# normalize the ugly how
         roll = m[2]
      }

      var suspension;
      if (roll && (/On motion to suspend the rules/i).test(motion)) suspension = true;

      //# alternate form of as amended, e.g. hr3979-113
      if ((/the House agree with an amendment/i).test(motion)) as_amended = true;
         
      action["type"] = "vote";
      action["vote_type"] = vote_type;
      action["how"] = how;
      action['where'] = "h";
      action['result'] = pass_fail;
      action["suspension"] = suspension;
      if (roll) action["roll"] = roll;

      //# get the new status of the bill after this vote
      new_status = new_status_after_vote(vote_type, pass_fail == "pass", "h", bill_type, suspension, as_amended, title, prev_status)
      if (new_status) status = new_status;
   }

   //# Passed House, not necessarily by an actual vote (think "deem")
   m = text.match(/Passed House pursuant to|House agreed to Senate amendment (with amendment )?pursuant to|Pursuant to the provisions of [HSCONJRES\. ]+ \d+, [HSCONJRES\. ]+ \d+ is considered passed House/i);
   if (m) {
      vote_type = bill_type == "hr" ? "vote" : "vote2";
      if ((/agreed to Senate amendment/i).test(text)) vote_type = "pingpong";

      pass_fail = "pass"
      as_amended = (/with amendment/i).test(text) || (/as amended/).test(text);

      action["type"] = "vote";
      action["vote_type"] = vote_type;
      action["how"] = "by special rule";
      action["where"] = "h";
      action["result"] = pass_fail;

      //# It's always pursuant to another bill, and a bill number is given in the action line, which we parse out
      //# into the bill_ids field of the action. It's also represented
      //# structurally in the links->link elements of the original XML which we just put in "links".

      //# get the new status of the bill after this vote
      new_status = new_status_after_vote(vote_type, pass_fail == "pass", "h", bill_type, false, as_amended, title, prev_status);

      if (new_status) status = new_status;
   }

   //# House motions to table adversely dispose of a pending matter, if agreed to. An agreed-to "motion to table the measure",
   //# which is very infrequent, kills the legislation. If not agreed to, nothing changes. So this regex only captures
   //# agreed-to motions to table.
   matchString = "On motion to table the measure Agreed to"
   + " \?\(by voice vote\|without objection\|by \(the Yeas and Nays\|Yea-Nay Vote\|recorded vote\)"
   + "\: \(\\d\+ - \\d\+\(, \\d\+ Present\)\? \[ \\)\]\*\)\?\\(\(Roll no\\.\|Record Vote No\:\) \\d\+\\)\)";
   re = new RegExp(matchString,"i");
   m = text.match(re);
   if (m) {
      how = m[1];
      pass_fail = 'fail';

      //# In order to classify this as resulting in the same thing as regular failed vote on passage, new_status_after_vote
      //# needs to know if this was a vote in the originating chamber or not.
      if (prev_status == "INTRODUCED" || bill_id.startsWith("hres")) vote_type = "vote";
      else vote_type = "vote2";

      var roll;
      m = how.match(/\((Roll no\.|Record Vote No:) (\d+)\)/i);
      if(m) {
         how = "roll";  //# normalize the ugly how
         roll = m[2];
      }
       
      action["type"] = "vote";
      action["vote_type"] = vote_type;
      action["how"] = how;
      action['where'] = "h";
      action['result'] = pass_fail;
      
      if (roll) action["roll"] = roll;

      //# get the new status of the bill after this vote
      new_status = new_status_after_vote(vote_type, pass_fail == "pass", "h", bill_type, false, false, title, prev_status);
      if (new_status) status = new_status;
   }

   //# A Senate Vote
   // # (There are some annoying weird cases of double spaces which are taken care of
   // # at the end.)
   matchString = "\("
      + [
      "Passed Senate",
      "Failed of passage in Senate",
      "Disagreed to in Senate",
      "Resolution agreed to in Senate",
      "Senate \(\?\:agreed to\|concurred in\) \(\?\:the \)\?\(\?\:conference report\|House amendment\(\?\: to the Senate amendments\?\| to the House amendments\?\)\*\)",
      "Senate receded from its amendment and concurred", //# hr1-115
      "Cloture \\S\*\\s\?on the motion to proceed \.\*\?not invoked in Senate",
      "Cloture\(\?\: motion\)\? on the motion to proceed to the \(\?\:bill\|measure\) invoked in Senate",
      "Cloture invoked in Senate",
      "Cloture on \(\?\:the motion to \(\?\:proceed to \|concur in \)\(\?\:the House amendment \(\?\:to the Senate amendment \)\?to \)\?\)\(\?\:the bill\|H.R. .\*\) \(\?\:not \)\?invoked in Senate",
      "\(\?\:Introduced\|Received\|Submitted\) in the Senate, \(\?\:read twice, \|considered, \|read the third time, \)\+and \(\?\:passed\|agreed to\)",
      ].join("\|")
      + "\)"
      + "\(\,\?\.\*\,\?\) "
      + "\(without objection\|by Unanimous Consent\|by Voice Vote\|\(\?\:by \)\?Yea-Nay\( Vote\)\?\\. \\d\+\\s\*-\\s\*\\d\+\\. Record Vote \(No\|Number\)\: \\d\+\)";
   re = new RegExp(matchString,"i");
   m = text.replace("  ", " ").match(matchString);
   if(m) {
      var motion = m[1]; 
      var extra = m[2];
      var how = m[3];

      var roll;

      //# put disagreed check first, cause "agreed" is contained inside it
      if ((/disagreed|not invoked/i).test(motion)) pass_fail = "fail";
      else if ((/passed|agreed|concurred|invoked/i).test(motion)) pass_fail = "pass";      
      else pass_fail = "fail";

      var voteaction_type = "vote"
      if ((/over veto/i).test(extra)) vote_type = "override"
      else if ((/conference report/i).test(motion)) vote_type = "conference"
      else if ((/cloture/i).test(motion)) {
         vote_type = "cloture"
         voteaction_type = "vote-aux"  //# because it is not a vote on passage
      } else if((/Senate agreed to (the )?House amendment|Senate concurred in (the )?House amendment/i).test(motion)) vote_type = "pingpong";
      else if (bill_type == "s") vote_type = "vote"      
      else vote_type = "vote2";
            

      m = how.match(/Record Vote (No|Number): (\d+)/i);
      if (m) {
         roll = m[2];
         how = "roll";
      }
            
      var as_amended = false;
      if ((/with amendments|with an amendment/i).test(extra)) as_amended = true;
      action["type"] = voteaction_type;
      action["vote_type"] = vote_type;
      action["how"] = how;
      action["result"] = pass_fail;
      action["where"] = "s";
      if (roll) action["roll"] = roll;

      //# get the new status of the bill after this vote
      new_status = new_status_after_vote(vote_type, pass_fail == "pass", "s", bill_type, false, as_amended, title, prev_status)
      if (new_status) status = new_status;
   }

   //# TODO: Make a new status for this as pre-reported.
   m = text.match(/Placed on (the )?([\w ]+) Calendar( under ([\w ]+))?[,\.] Calendar No\. (\d+)\.|Committee Agreed to Seek Consideration Under Suspension of the Rules|Ordered to be Reported/i);
   if (m) {
      //# TODO: This makes no sense.
      if (prev_status == "INTRODUCED" || prev_status == "REFERRED") status = "REPORTED";
      action["type"] = "calendar";
   }

   //# reported
   m = text.match(/Committee on (.*)\. Reported by/i);
   if (m) {
      action["type"] = "reported";
      action["committee"] = m[1];
      if (prev_status == "INTRODUCED" || prev_status == "REFERRED") status = "REPORTED";
   }
        
   m = text.match(/Reported to Senate from the (.*?)( \(without written report\))?\./i)
   if (m) {  //# 93rd Congress
      action["type"] = "reported";
      action["committee"] = m[1];
      if (prev_status == "INTRODUCED" || prev_status == "REFERRED") status = "REPORTED";      
   }

   //# hearings held by a committee
   m = text.match(/(Committee on .*?)\. Hearings held/i);
   if (m) {
      action["committee"] = m[1];
      action["type"] = "hearings";
   }

   m = text.match(/Committee on (.*)\. Discharged (by Unanimous Consent)?/i);
   if (m) {
      action["committee"] = m.group(1)
      action["type"] = "discharged"
      if (prev_status == "INTRODUCED" || prev_status == "REFERRED") status = "REPORTED";
   }
        
   if ((/Cleared for White House|Presented to President/i).test(text)) action["type"] = "topresident";
       
   if ((/Signed by President/i).test(text)) {
      action["type"] = "signed";
      status = "ENACTED:SIGNED";
   }

   if ((/Pocket Vetoed by President/i).test(text)) {
      action["type"] = "vetoed";
      action["pocket"] = "1";
      status = "VETOED:POCKET";
   } else {
      if ((/Vetoed by President/i).test(text)) {
         action["type"] = "vetoed";
         status = "PROV_KILL:VETO";
      }
   }

   if ((/Sent to Archivist of the United States unsigned/).test(text)) status = "ENACTED:TENDAYRULE";
       
   m = text.match(/^(?:Became )?(Public|Private) Law(?: No:)? ([\d\-]+)\./i);
   if (m) {
      action["law"] = m[1].toLowerCase()
      var pieces = m[2].split("-")
      action["congress"] = pieces[0];
      action["number"] = pieces[1];
      action["type"] = "enacted";

      if (prev_status == "ENACTED:SIGNED" || prev_status == "ENACTED:VETO_OVERRIDE" || prev_status == "ENACTED:TENDAYRULE") status = status; //# this is a final administrative step
      else if (prev_status == "PROV_KILL:VETO" || prev_status.startsWith("VETOED:")) status = "ENACTED:VETO_OVERRIDE";         
      //else throw { statusCode: 404, message: `Missing Signed by President action? If this is a case of the 10-day rule, hard code the bill id ${bill_id} here.` }
   }

   //# Check for referral type
   if ((/Referred to (?:the )?(House|Senate)?\s?(?:Committee|Subcommittee)?/i).test(text)) {
      action["type"] = "referral"
      if (prev_status == "INTRODUCED") status = "REFERRED";  
   }

   return { action, status };
}

function new_status_after_vote(vote_type, passed, chamber, bill_type, suspension, amended, title, prev_status) {
   if (vote_type == "vote") {  //# vote in originating chamber
      if (passed) {
         if (bill_type == "hres" || bill_type == "sres") return 'PASSED:SIMPLERES'; //# end of life for a simple resolution
         if (chamber == "h") return 'PASS_OVER:HOUSE';  //# passed by originating chamber, now in second chamber  
         else return 'PASS_OVER:SENATE';  //# passed by originating chamber, now in second chamber
      } else if (suspension) return 'PROV_KILL:SUSPENSIONFAILED'  //# provisionally killed by failure to pass under suspension of the rules
         
      if (chamber == "h") return 'FAIL:ORIGINATING:HOUSE'  //# outright failure   
      else return 'FAIL:ORIGINATING:SENATE'  //# outright failure
   }
         
   if (vote_type == "vote2" || vote_type == "pingpong") {//  # vote in second chamber or subsequent pingpong votes
      if (passed) {
         if (amended) {
            //# mesure is passed but not in identical form
            if (chamber == "h") return 'PASS_BACK:HOUSE';  //# passed both chambers, but House sends it back to Senate
            else return 'PASS_BACK:SENATE' ; //# passed both chambers, but Senate sends it back to House 
         } else {
            //# bills and joint resolutions not constitutional amendments, not amended from Senate version
            if ((bill_type == "hjres" || bill_type == "sjres") && title.startsWith("Proposing an amendment to the Constitution of the United States")) {
               return 'PASSED:CONSTAMEND';  //# joint resolution that looks like an amendment to the constitution
            }
            if (bill_type == "hconres" || bill_type == "sconres") {
               return 'PASSED:CONCURRENTRES';  //# end of life for concurrent resolutions
            }
            return 'PASSED:BILL';  //# passed by second chamber, now on to president
         }
      }

      if (vote_type == "pingpong") {
         //# chamber failed to accept the other chamber's changes, but it can vote again
         return 'PROV_KILL:PINGPONGFAIL'
      }
      if (suspension) {
         //# provisionally killed by failure to pass under suspension of the rules
         return 'PROV_KILL:SUSPENSIONFAILED';
      }
      if (chamber == "h") {
         return 'FAIL:SECOND:HOUSE'  //# outright failure
      }
      else return 'FAIL:SECOND:SENATE'  //# outright failure
   }

   if (vote_type == "cloture") {
      if (!passed) return "PROV_KILL:CLOTUREFAILED";
      else return;
   }

   if (vote_type == "override") {
      if (!passed) {
         if (bill_type == chamber) {
            if (chamber == "h") return 'VETOED:OVERRIDE_FAIL_ORIGINATING:HOUSE';
            else return 'VETOED:OVERRIDE_FAIL_ORIGINATING:SENATE';
         } else {
            if (chamber == "h") return 'VETOED:OVERRIDE_FAIL_SECOND:HOUSE';
            else return 'VETOED:OVERRIDE_FAIL_SECOND:SENATE';
         }
      } else {
         if (bill_type == chamber) {
            if (chamber == "h") return 'VETOED:OVERRIDE_PASS_OVER:HOUSE';
            else return 'VETOED:OVERRIDE_PASS_OVER:SENATE';
         }
         else {
            //# The override passed both chambers -- the veto is overridden.
            return "ENACTED:VETO_OVERRIDE"
         }
      }
   }

   if (vote_type == "conference") {
      //# This is tricky to integrate into status because we have to wait for both
      //# chambers to pass the conference report.
      if (passed) {
         if (prev_status.startsWith("CONFERENCE:PASSED:")) {
            if ((bill_type == "hjres" || bill_type == "sjres") && title.startsWith("Proposing an amendment to the Constitution of the United States")) {
               return 'PASSED:CONSTAMEND';  //# joint resolution that looks like an amendment to the constitution
            }
            if (bill_type == "hconres" || bill_type == "sconres") {
               return 'PASSED:CONCURRENTRES';  //# end of life for concurrent resolutions
            }
            return 'PASSED:BILL';
         } else {
            if (chamber == "h") return 'CONFERENCE:PASSED:HOUSE'
            else return 'CONFERENCE:PASSED:SENATE'
         }
      }
   }
}

function history_from_actions(actions) {
   var history = {}

   var activation = activation_from(actions)
   if (activation) {
      history['active'] = true;
      history['active_at'] = activation['acted_at'];
   } else history['active'] = false;
        
   var house_vote = actions.filter(action => (action['type'] == 'vote') && (action['where'] == 'h') && (action['vote_type'] != "override")).pop();
   if (house_vote) {
      history['house_passage_result'] = house_vote['result'];
      history['house_passage_result_at'] = house_vote['acted_at'];
   }

   var senate_vote = actions.filter(action => (action['type'] == 'vote') && (action['where'] == 's') && (action['vote_type'] != "override")).pop();
   if (senate_vote) {
      history['senate_passage_result'] = senate_vote['result']
      history['senate_passage_result_at'] = senate_vote['acted_at']
   }

   var senate_vote = actions.filter(action => (action['type'] == 'vote-aux') && (action['vote_type'] == 'cloture') && (action['where'] == 's') && (action['vote_type'] != "override")).pop();
   if (senate_vote) {
      history['senate_cloture_result'] = senate_vote['result']
      history['senate_cloture_result_at'] = senate_vote['acted_at']
   }

   var vetoed = actions.filter(action => action.type === 'vetoed').pop();
   if (vetoed) {
      history['vetoed'] = true;
      history['vetoed_at'] = vetoed['acted_at'];
   } else history['vetoed'] = false;

   var house_override_vote = actions.filter(action => ((action['type'] == 'vote') && (action['where'] == 'h') && (action['vote_type'] == "override"))).pop();
   if (house_override_vote) {
      history['house_override_result'] = house_override_vote['result']
      history['house_override_result_at'] = house_override_vote['acted_at']
   }

   var senate_override_vote = actions.filter(action => ((action['type'] == 'vote') && (action['where'] == 's') && (action['vote_type'] == "override"))).pop();
   if (senate_override_vote) {
      history['senate_override_result'] = senate_override_vote['result'];
      history['senate_override_result_at'] = senate_override_vote['acted_at'];
   }

   var enacted = actions.filter(action => action.type === 'enacted').pop();
   if (enacted) {
        history['enacted'] = true;
        history['enacted_at'] = enacted['acted_at'];
   } else history['enacted'] = false;

   var topresident = actions.filter(action => action.type === 'topresident').pop();
   if (topresident && (!history['vetoed']) && (!history['enacted'])) {
      history['awaiting_signature'] = true;
      history['awaiting_signature_since'] = topresident['acted_at'];
   } else history['awaiting_signature'] = false;
   
   return history;
}

/*# find the first action beyond the standard actions every bill gets.
# - if the bill's first action is "referral" then the first action not those
#     most common
#     e.g. hr3590-111 (active), s1-113 (inactive)
# - if the bill's first action is "action", then the next action, if one is present
#     resolutions
#     e.g. sres5-113 (active), sres4-113 (inactive)
# - if the bill's first action is anything else (e.g. "vote"), then that first action
#     bills that skip committee
#     e.g. s227-113 (active)*/
function activation_from(actions = []) {
   //# there's NOT always at least one :(
   //# as of 2013-06-10, hr2272-113 has no actions at all
   if (actions.length === 0) return [];

   const first = actions[0];

   if (first['type'] == "referral" || first['type'] == "calendar" || first['type'] == "action") {
      for (const action of actions.slice(1)) {
         if ((action['type'] != "referral") && (action['type'] != "calendar") && (!(/"Sponsor introductory remarks"/i).test(action['text']))) return action;
      }
   } else return first;   
}

function related_bills_for(relatedBillsNode = {}) {
   const { item: related_bills = [] } = relatedBillsNode;
   if(related_bills.length === 0) return [];

   function build_dict(item) {
      const { congress, number, type, relationshipDetails = {} } = transformNode(item);
      const { item: relationshipDetailsItem = [] } = relationshipDetails;

      if(relationshipDetailsItem.length === 0) {
         return {
            'bill_id': `${type.replace(".","").toLowerCase()}${number}-${congress}`,
            'type': 'bill',
         }
      } else {
         const { type: relationship_type, identifiedBy } = transformNode(relationshipDetailsItem.pop());
         return {
            'reason': relationship_type.replace('bill', '').trim().toLowerCase(),
            'bill_id': `${type.replace(".","").toLowerCase()}${number}-${congress}`,
            'type': 'bill',
            'identified_by': identifiedBy
         }
      }
   }

   return related_bills.map(build_dict);
}


async function transformGovInfoBill(govInfoBill) {
   /*Handles converting a government bulk XML file to legacy dictionary form*/

   const { bill: billNode = [] } = await xml2js.parseStringPromise(govInfoBill, { explicitRoot: false, ignoreAttrs: true });
   const bill_dict = transformNode(billNode.pop());

   const {  billType, 
            billNumber, 
            congress, 
            updateDate, 
            introducedDate,
            title, 
            policyArea = { },
            titles: titlesNode = {}, 
            actions: actionsNode = {}, 
            sponsors: sponsorsNode = {}, 
            cosponsors: cosponsorsNode = {}, 
            summaries: billSummariesNode = {},
            relatedBills: relatedBillsNode = {} } = bill_dict;
   const bill_id = build_bill_id(billType.toLowerCase(), billNumber, congress);
   const titles = titles_for(titlesNode);
   const actions = actions_for(actionsNode, bill_id, current_title_for(titles, 'official'))
   const { status, status_date } = latest_status(actions, introducedDate);
   const { name: subjects = [] } = policyArea;
   var primary_subject;
   if(subjects.length > 0) primary_subject = subjects.pop().toLowerCase();

   const bill_data = {
      'bill_id': bill_id,
      'bill_type': billType.toLowerCase(),
      'number': billNumber,
      'congress': congress,
      'url': billstatus_url_for(bill_id),
      'introduced_at': introducedDate,
      'sponsor': sponsor_for(sponsorsNode),
      'cosponsors': cosponsors_for(cosponsorsNode),
      'actions': actions,
      'history': history_from_actions(actions),
      'status': status,
      'status_at': status_date,
      'titles': titles,
      'official_title': title,
      'short_title': current_title_for(titles, "short"),
      'popular_title': current_title_for(titles, "popular"),
      'summary': summary_for(billSummariesNode),
      'subjects_top_term': primary_subject,
      'related_bills': related_bills_for(relatedBillsNode),
      'updated_at': updateDate
   }

   return bill_data;
}

async function fetchBill(bucket, key) {
  const { Body } = await s3.getObject({ Bucket: bucket, Key: key }).promise();
  if(Body) return Body.toString();
  else throw { statusCode: 404, message: "Bill not found" };
}

async function createBillJSON(bucket, bill = {}) {
  const { congress, bill_type, number } = bill;
  if(bill) await s3.upload({ Bucket: bucket, Key: `congress/${congress}/${bill_type}/${number}.json`, Body: JSON.stringify(bill), ContentType: "application/json" }).promise();
}
