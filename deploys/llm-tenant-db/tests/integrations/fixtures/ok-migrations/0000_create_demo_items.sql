CREATE SCHEMA IF NOT EXISTS llm_tenant;
--> statement-breakpoint
CREATE TABLE llm_tenant.demo_items (
	id integer PRIMARY KEY,
	label text NOT NULL
);
