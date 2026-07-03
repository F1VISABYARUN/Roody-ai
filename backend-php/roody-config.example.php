<?php
// Roody proxy configuration — COPY to roody-config.php and fill in.
//
// SECURITY: upload roody-config.php ONE LEVEL ABOVE public_html
// (e.g. /home/uXXXX/domains/yourdomain.com/roody-config.php) so it can
// never be downloaded by a browser. roody-proxy.php looks for it there
// first, then falls back to its own folder.

return [
  // Your Gemini API key (server-side only — never ships in the extension)
  'gemini_key' => 'AIza...PASTE-YOURS',

  // MySQL — from hPanel → Databases → Management
  'db_host' => 'localhost',
  'db_name' => 'uXXXXXXXXX_roody',
  'db_user' => 'uXXXXXXXXX_roody',
  'db_pass' => 'your-db-password',
];
