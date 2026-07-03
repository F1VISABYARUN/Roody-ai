-- Roody credits backend (MySQL / Hostinger version).
-- Run this in hPanel → phpMyAdmin → your database → SQL tab.

CREATE TABLE IF NOT EXISTS codes (
  code        VARCHAR(32)  NOT NULL PRIMARY KEY,
  name        VARCHAR(100) NULL,             -- who you gave it to (your note)
  daily_limit INT          NOT NULL DEFAULT 50,
  active      TINYINT(1)   NOT NULL DEFAULT 1,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS usage_log (
  code  VARCHAR(32) NOT NULL,
  day   DATE        NOT NULL,
  count INT         NOT NULL DEFAULT 0,
  PRIMARY KEY (code, day),
  FOREIGN KEY (code) REFERENCES codes(code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Mint your first two tester codes (run, then SELECT to read them):
INSERT INTO codes (code, name) VALUES
  (CONCAT('ROODY-', UPPER(SUBSTRING(MD5(RAND()), 1, 8))), 'Tester 1'),
  (CONCAT('ROODY-', UPPER(SUBSTRING(MD5(RAND()), 1, 8))), 'Tester 2');

SELECT code, name FROM codes ORDER BY created_at DESC;

-- ---------------------------------------------------------------------------
-- ADMIN CHEAT SHEET (phpMyAdmin → SQL tab, any time)
-- ---------------------------------------------------------------------------
-- Today's usage per user:
--   SELECT c.name, u.code, u.count, c.daily_limit
--   FROM usage_log u JOIN codes c USING (code)
--   WHERE u.day = CURDATE() ORDER BY u.count DESC;
--
-- Mint another code:
--   INSERT INTO codes (code, name) VALUES
--     (CONCAT('ROODY-', UPPER(SUBSTRING(MD5(RAND()), 1, 8))), 'Friend 3');
--
-- Kill a user instantly:
--   UPDATE codes SET active = 0 WHERE code = 'ROODY-XXXXXXXX';
--
-- Raise a limit:
--   UPDATE codes SET daily_limit = 200 WHERE code = 'ROODY-XXXXXXXX';
--
-- Total messages you're paying for today:
--   SELECT SUM(count) FROM usage_log WHERE day = CURDATE();
