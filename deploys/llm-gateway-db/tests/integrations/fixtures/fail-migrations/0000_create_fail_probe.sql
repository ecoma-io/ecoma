CREATE SCHEMA IF NOT EXISTS llm_gateway;
--> statement-breakpoint
CREATE TABLE llm_gateway.fail_probe (
	id integer PRIMARY KEY
);
