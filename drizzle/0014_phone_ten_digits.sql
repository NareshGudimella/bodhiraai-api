-- not in legacy: phones are stored as exactly 10 digits (rules.ts PHONE_FORMAT).
-- Indian numbers saved with +91 / 91, spaces or dashes become their 10 digits;
-- anything else is left as it is (it must be corrected on the next edit).
UPDATE "users"
SET "phone" = CASE
  WHEN length(regexp_replace("phone", '\D', '', 'g')) = 10 THEN regexp_replace("phone", '\D', '', 'g')
  ELSE right(regexp_replace("phone", '\D', '', 'g'), 10)
END
WHERE "phone" IS NOT NULL
  AND "phone" !~ '^[0-9]{10}$'
  AND (
    length(regexp_replace("phone", '\D', '', 'g')) = 10
    OR regexp_replace("phone", '\D', '', 'g') ~ '^91[0-9]{10}$'
  );
