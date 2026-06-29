'use strict';
// Local development only — not used in Lambda/Netlify deployments

require('dotenv').config();
const createApp = require('./app');
const config = require('./config');

const app = createApp();
app.listen(config.app.port, () => {
  process.stdout.write(`Server running on http://localhost:${config.app.port} [${config.app.nodeEnv}]\n`);
});
