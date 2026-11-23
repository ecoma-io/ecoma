CREATE SCHEMA IF NOT EXISTS pact_broker_app;
--> statement-breakpoint
CREATE TABLE pact_broker_app.demo_items (
	id integer PRIMARY KEY,
	label text NOT NULL
);
