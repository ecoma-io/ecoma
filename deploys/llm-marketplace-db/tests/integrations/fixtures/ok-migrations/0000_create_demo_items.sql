CREATE SCHEMA IF NOT EXISTS llm_marketplace;
--> statement-breakpoint
CREATE TABLE llm_marketplace.demo_items (
	id integer PRIMARY KEY,
	label text NOT NULL
);
