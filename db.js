const { MongoClient } = require('mongodb');

const uri = process.env.MONGODB_URI;
let client;
let dbPromise;

function connect() {
  if (!uri) {
    throw new Error('MONGODB_URI environment variable topilmadi. .env faylni tekshiring.');
  }
  if (!dbPromise) {
    client = new MongoClient(uri);
    dbPromise = client.connect().then(() => client.db('lidlar'));
  }
  return dbPromise;
}

async function getLeadsCollection() {
  const db = await connect();
  return db.collection('leads');
}

async function getEmployeesCollection() {
  const db = await connect();
  return db.collection('employees');
}

module.exports = { getLeadsCollection, getEmployeesCollection };
