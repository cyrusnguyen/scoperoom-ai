-- Match the established ECMAScript trim contract without changing retained reason bytes.
ALTER TABLE app.review_request DROP CONSTRAINT review_request_reason;
ALTER TABLE app.review_request ADD CONSTRAINT review_request_reason CHECK (
  closed_reason IS NULL OR (char_length(closed_reason) BETWEEN 1 AND 4000 AND btrim(closed_reason, U&' \0009\000A\000B\000C\000D\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') <> '')
);

-- Legacy decisions have unknown attribution. Capture metadata only for new decisions.
-- The existing whole-row review_decision_immutable guard also protects these columns.
ALTER TABLE app.review_decision
  ADD COLUMN actor_display_name text,
  ADD COLUMN actor_role text,
  ADD CONSTRAINT review_decision_actor_attribution CHECK (
    (actor_display_name IS NULL AND actor_role IS NULL)
    OR (actor_display_name IS NOT NULL AND actor_role IS NOT NULL
      AND char_length(actor_display_name) BETWEEN 1 AND 120
      AND btrim(actor_display_name, U&' \0009\000A\000B\000C\000D\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') <> ''
      AND actor_role IN ('OWNER','EDITOR','REVIEWER'))
  );
