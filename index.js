'use strict';
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const cookieSession = require('cookie-session');
const { getRouter } = require('stremio-addon-sdk');
const addon = require('./src/addon');
const configureRoutes = require('./src/routes/configure');
const traktRoutes = require('./src/routes/trakt');
const adminRoutes = require('./src/routes/admin');
const { initDb } = require('./src/db');
const { config, validate } = require('./src/config');

try {
  validate();
  initDb();
} catch (err) {
  console.error('Startup failed:', err.message);
  process.exit(1);
}

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

const app = express();

app.use(cors());
app.use(express.json());
app.set('trust proxy', 1);
app.use(cookieSession({
  name: 'session',
  keys: [config.sessionSecret],
  maxAge: 24 * 60 * 60 * 1000,
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production'
}));
app.use(express.static('src/public'));

app.use('/', configureRoutes);
app.use('/trakt', traktRoutes);
app.use('/admin', adminRoutes);
app.use('/', getRouter(addon.getInterface()));

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.stack || err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Internal server error' });
});

const port = config.port;
app.listen(port, () => {
  console.log(`Bender addon running at ${config.baseUrl}`);
  console.log(`Configure at ${config.baseUrl}/configure`);
});
