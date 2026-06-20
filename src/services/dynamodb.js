'use strict';

/**
 * dynamodb.js
 *
 * Thin wrapper around AWS DynamoDB DocumentClient.
 * Each function maps to a specific table / access pattern.
 *
 * Tables:
 *   finance-users         – one record per Cognito userId (sub)
 *   finance-plaid-items   – bank connections (PK: userId, SK: itemId)
 *   finance-budgets       – budget categories (PK: userId, SK: budgetId)
 *   finance-transactions  – Plaid transactions (PK: userId, SK: date#txnId)
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  QueryCommand,
} = require('@aws-sdk/lib-dynamodb');
const config = require('../config');

const rawClient = new DynamoDBClient({ region: config.aws.region });
const db = DynamoDBDocumentClient.from(rawClient, {
  marshallOptions: { removeUndefinedValues: true },
});

const T = config.dynamo; // table name shortcuts

// ─── Users ──────────────────────────────────────────────────────────────────

async function getUser(userId) {
  const { Item } = await db.send(new GetCommand({ TableName: T.usersTable, Key: { userId } }));
  return Item || null;
}

async function createUser(userId, { email }) {
  const now = new Date().toISOString();
  const item = { userId, email, createdAt: now, updatedAt: now, plaidLinked: false };
  await db.send(new PutCommand({ TableName: T.usersTable, Item: item, ConditionExpression: 'attribute_not_exists(userId)' }));
  return item;
}

async function updateUser(userId, attrs) {
  const fields = Object.entries({ ...attrs, updatedAt: new Date().toISOString() });
  const expr = 'SET ' + fields.map((_, i) => `#f${i} = :v${i}`).join(', ');
  const names = Object.fromEntries(fields.map(([k], i) => [`#f${i}`, k]));
  const values = Object.fromEntries(fields.map(([, v], i) => [`:v${i}`, v]));
  const { Attributes } = await db.send(
    new UpdateCommand({
      TableName: T.usersTable,
      Key: { userId },
      UpdateExpression: expr,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
    })
  );
  return Attributes;
}

// ─── Plaid Items ─────────────────────────────────────────────────────────────

async function savePlaidItem(userId, itemId, { encryptedAccessToken, institutionId, institutionName, accounts }) {
  const now = new Date().toISOString();
  await db.send(
    new PutCommand({
      TableName: T.plaidTable,
      Item: { userId, itemId, encryptedAccessToken, institutionId, institutionName, accounts, createdAt: now },
    })
  );
}

async function getPlaidItems(userId) {
  const { Items } = await db.send(
    new QueryCommand({ TableName: T.plaidTable, KeyConditionExpression: 'userId = :u', ExpressionAttributeValues: { ':u': userId } })
  );
  return Items || [];
}

async function getPlaidItem(userId, itemId) {
  const { Item } = await db.send(new GetCommand({ TableName: T.plaidTable, Key: { userId, itemId } }));
  return Item || null;
}

async function deletePlaidItem(userId, itemId) {
  await db.send(new DeleteCommand({ TableName: T.plaidTable, Key: { userId, itemId } }));
}

// ─── Budgets ─────────────────────────────────────────────────────────────────

async function getBudgets(userId) {
  const { Items } = await db.send(
    new QueryCommand({ TableName: T.budgetsTable, KeyConditionExpression: 'userId = :u', ExpressionAttributeValues: { ':u': userId } })
  );
  return Items || [];
}

async function getBudget(userId, budgetId) {
  const { Item } = await db.send(new GetCommand({ TableName: T.budgetsTable, Key: { userId, budgetId } }));
  return Item || null;
}

async function createBudget(userId, budgetId, { name, amount, category, period }) {
  const now = new Date().toISOString();
  const item = { userId, budgetId, name, amount, category, period, spent: 0, createdAt: now, updatedAt: now };
  await db.send(new PutCommand({ TableName: T.budgetsTable, Item: item }));
  return item;
}

async function updateBudget(userId, budgetId, attrs) {
  const fields = Object.entries({ ...attrs, updatedAt: new Date().toISOString() });
  const expr = 'SET ' + fields.map((_, i) => `#f${i} = :v${i}`).join(', ');
  const names = Object.fromEntries(fields.map(([k], i) => [`#f${i}`, k]));
  const values = Object.fromEntries(fields.map(([, v], i) => [`:v${i}`, v]));
  const { Attributes } = await db.send(
    new UpdateCommand({
      TableName: T.budgetsTable,
      Key: { userId, budgetId },
      UpdateExpression: expr,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ConditionExpression: 'attribute_exists(userId)',
      ReturnValues: 'ALL_NEW',
    })
  );
  return Attributes;
}

async function deleteBudget(userId, budgetId) {
  await db.send(
    new DeleteCommand({
      TableName: T.budgetsTable,
      Key: { userId, budgetId },
      ConditionExpression: 'attribute_exists(userId)',
    })
  );
}

// ─── Transactions ─────────────────────────────────────────────────────────────

/**
 * Upsert a batch of Plaid transactions for a user.
 * sortKey = "<date>#<transactionId>" ensures chronological sort + uniqueness.
 */
async function saveTransactions(userId, transactions) {
  // DynamoDB BatchWrite is limited to 25 items; handle chunking
  const CHUNK = 25;
  const now = new Date().toISOString();
  for (let i = 0; i < transactions.length; i += CHUNK) {
    const chunk = transactions.slice(i, i + CHUNK);
    const { BatchWriteItemCommand } = require('@aws-sdk/client-dynamodb');
    const { marshall } = require('@aws-sdk/util-dynamodb');
    const writeRequests = chunk.map((txn) => ({
      PutRequest: {
        Item: marshall({
          userId,
          sortKey: `${txn.date}#${txn.transaction_id}`,
          transactionId: txn.transaction_id,
          accountId: txn.account_id,
          amount: txn.amount,
          merchant: txn.merchant_name || txn.name,
          category: txn.personal_finance_category?.primary || (txn.category?.[0] ?? 'OTHER'),
          date: txn.date,
          pending: txn.pending,
          syncedAt: now,
        }, { removeUndefinedValues: true }),
      },
    }));
    await rawClient.send(
      new BatchWriteItemCommand({ RequestItems: { [T.transactionsTable]: writeRequests } })
    );
  }
}

async function getTransactions(userId, { limit = 50, startKey } = {}) {
  const params = {
    TableName: T.transactionsTable,
    KeyConditionExpression: 'userId = :u',
    ExpressionAttributeValues: { ':u': userId },
    Limit: limit,
    ScanIndexForward: false, // newest first
  };
  if (startKey) params.ExclusiveStartKey = startKey;
  const { Items, LastEvaluatedKey } = await db.send(new QueryCommand(params));
  return { items: Items || [], nextKey: LastEvaluatedKey || null };
}

module.exports = {
  getUser, createUser, updateUser,
  savePlaidItem, getPlaidItems, getPlaidItem, deletePlaidItem,
  getBudgets, getBudget, createBudget, updateBudget, deleteBudget,
  saveTransactions, getTransactions,
};
