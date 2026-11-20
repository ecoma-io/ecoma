CREATE SCHEMA IF NOT EXISTS staff_access;
--> statement-breakpoint
CREATE TABLE staff_access.demo_items (
	id integer PRIMARY KEY,
	label text NOT NULL
);
