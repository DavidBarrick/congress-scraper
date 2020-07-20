## congress-scraper

Public domain code that collects data about bills from the U.S. Congress.

This code has been ported to NodeJS from the [unitedstates/congress](https://github.com/unitedstates/congress) project.

## How To Run

1. **Install package dependencies**

```bash
npm install
```

2. **Install Serverless Framework**

```bash
npm install -g serverless
```

3. **Setup Serverless Framework With AWS Credentials**
https://www.serverless.com/framework/docs/providers/aws/guide/credentials/

4. **Deploy service**

```bash
sls deploy
```

5. **Run bill fetcher**

```bash
sls invoke -f fetchBills
```

This will start the download process. All XML and JSON data will be in an S3 bucket with a name starting with "congress-"