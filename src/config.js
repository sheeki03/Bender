'use strict';
require('dotenv').config();

const config = {
  port: parseInt(process.env.PORT, 10) || 7000,
  baseUrl: process.env.BASE_URL || 'http://localhost:7000',
  tmdbApiKey: process.env.TMDB_API_KEY,
  traktClientId: process.env.TRAKT_CLIENT_ID,
  traktClientSecret: process.env.TRAKT_CLIENT_SECRET,
  encryptionKey: process.env.ENCRYPTION_KEY,
  sessionSecret: process.env.SESSION_SECRET,
  dbPath: process.env.DB_PATH || 'data/recommendations.db',
};

function validate() {
  const required = ['tmdbApiKey', 'encryptionKey', 'sessionSecret'];
  const missing = required.filter(k => !config[k]);
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}. See .env.example`);
  }
  if (!/^[0-9a-f]{64}$/i.test(config.encryptionKey)) {
    throw new Error('ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes)');
  }
  if (!config.traktClientId || !config.traktClientSecret) {
    console.warn('Warning: TRAKT_CLIENT_ID and TRAKT_CLIENT_SECRET not set. Trakt OAuth will not work.');
  }
}

module.exports = { config, validate };
