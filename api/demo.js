const { waitUntil } = require('@vercel/functions');
const { createDemo } = require('../server/demo');
module.exports = createDemo({ defer: waitUntil });
