CREATE SCHEMA IF NOT EXISTS remote_cache_app;
--> statement-breakpoint
CREATE TABLE remote_cache_app.demo_items (
	id integer PRIMARY KEY,
	label text NOT NULL
);
