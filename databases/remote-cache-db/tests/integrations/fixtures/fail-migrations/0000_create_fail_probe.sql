CREATE SCHEMA IF NOT EXISTS remote_cache;
--> statement-breakpoint
CREATE TABLE remote_cache.fail_probe (
	id integer PRIMARY KEY
);
