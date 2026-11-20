CREATE SCHEMA IF NOT EXISTS account;
--> statement-breakpoint
CREATE TABLE account.demo_items (
	id integer PRIMARY KEY,
	label text NOT NULL
);
