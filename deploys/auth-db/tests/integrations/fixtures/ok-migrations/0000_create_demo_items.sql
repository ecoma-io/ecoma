CREATE SCHEMA IF NOT EXISTS auth;
--> statement-breakpoint
CREATE TABLE auth.demo_items (
	id integer PRIMARY KEY,
	label text NOT NULL
);
