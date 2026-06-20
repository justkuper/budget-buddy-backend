#!/usr/bin/env node
'use strict';

/**
 * create-tables.js
 *
 * Run once to create DynamoDB tables locally or in AWS:
 *   npm run tables:create
 *
 * Requires AWS credentials + region in environment (or ~/.aws/credentials).
 * For local development with DynamoDB Local, set AWS_ENDPOINT_URL=http://localhost:8000
 */

require('dotenv').config();
const { DynamoDBClient, CreateTableCommand, ListTablesCommand } = require('@aws-sdk/client-dynamodb');
const config = require('../src/config');

const client = new DynamoDBClient({
  region: config.aws.region,
  ...(process.env.AWS_ENDPOINT_URL ? { endpoint: process.env.AWS_ENDPOINT_URL } : {}),
});

const stage = process.env.STAGE || 'dev';

const tables = [
  {
    TableName: `finance-${stage}-users`,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [{ AttributeName: 'userId', AttributeType: 'S' }],
    KeySchema: [{ AttributeName: 'userId', KeyType: 'HASH' }],
  },
  {
    TableName: `finance-${stage}-plaid-items`,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [
      { AttributeName: 'userId', AttributeType: 'S' },
      { AttributeName: 'itemId', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'userId', KeyType: 'HASH' },
      { AttributeName: 'itemId', KeyType: 'RANGE' },
    ],
  },
  {
    TableName: `finance-${stage}-budgets`,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [
      { AttributeName: 'userId', AttributeType: 'S' },
      { AttributeName: 'budgetId', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'userId', KeyType: 'HASH' },
      { AttributeName: 'budgetId', KeyType: 'RANGE' },
    ],
  },
  {
    TableName: `finance-${stage}-transactions`,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [
      { AttributeName: 'userId', AttributeType: 'S' },
      { AttributeName: 'sortKey', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'userId', KeyType: 'HASH' },
      { AttributeName: 'sortKey', KeyType: 'RANGE' },
    ],
  },
];

async function run() {
  const { TableNames: existing } = await client.send(new ListTablesCommand({}));

  for (const def of tables) {
    if (existing.includes(def.TableName)) {
      console.log(`  ✓ ${def.TableName} already exists`);
      continue;
    }
    await client.send(new CreateTableCommand(def));
    console.log(`  ✓ Created ${def.TableName}`);
  }
  console.log('\nAll tables ready.');
}

run().catch((err) => { console.error(err); process.exit(1); });
