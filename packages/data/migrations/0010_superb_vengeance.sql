-- When an operator last said no to a claim (ADR 0045): from then on only the tag or rel="me"
-- proves it. A rejection or removal made before this column existed is in the admin ledger, so it
-- is carried over: the latest of each claim's not undone (an undo row names its group). The column
-- is not synced, so nothing here bumps the seq.
ALTER TABLE `site_claims` ADD `overruled_at` integer;--> statement-breakpoint
UPDATE `site_claims` SET `overruled_at` = (
  SELECT max(a.at) FROM `admin_actions` a
  WHERE a.target_kind = 'claim' AND a.target_key = cast(`site_claims`.`id` AS text)
    AND a.action IN ('claim.reject', 'claim.remove')
    AND NOT EXISTS (
      SELECT 1 FROM `admin_actions` u
      WHERE u.action = 'undo' AND json_extract(u.detail, '$.group') = a.group_id
    )
);
