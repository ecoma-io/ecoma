CREATE SCHEMA IF NOT EXISTS llm_gateway;
--> statement-breakpoint
CREATE TABLE llm_gateway.demo_items (
	id integer PRIMARY KEY,
	label text NOT NULL
);
