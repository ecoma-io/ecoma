CREATE SCHEMA IF NOT EXISTS pact_broker;
--> statement-breakpoint
CREATE TABLE pact_broker.demo_items (
	id integer PRIMARY KEY,
	label text NOT NULL
);
