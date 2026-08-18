// Vercel entry point: the Express app is exported as the function handler.
// vercel.json rewrites every /api/* request here, so Express does its own routing.
module.exports = require('../src/app');
