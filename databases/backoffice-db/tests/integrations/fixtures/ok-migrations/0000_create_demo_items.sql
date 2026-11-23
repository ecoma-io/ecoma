CREATE SCHEMA IF NOT EXISTS backoffice;
--> statement-breakpoint
CREATE TABLE backoffice.demo_items (
	id integer PRIMARY KEY,
	label text NOT NULL
);
