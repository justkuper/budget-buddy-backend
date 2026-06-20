'use strict';
// Local development only — not used in Lambda/Netlify deployments

require('dotenv').config();
const createApp = require('./app');
const config = require('./config');

const app = createApp();
app.listen(config.app.port, () => {
  console.log(`Server running on http://localhost:${config.app.port}`);
  console.log(`Environment: ${config.app.nodeEnv}`);
});
