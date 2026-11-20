CREATE SCHEMA IF NOT EXISTS remote_cache;
--> statement-breakpoint
CREATE TABLE remote_cache.demo_items (
	id integer PRIMARY KEY,
	label text NOT NULL
);
