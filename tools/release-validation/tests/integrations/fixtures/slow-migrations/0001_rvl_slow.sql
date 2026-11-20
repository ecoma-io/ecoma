CREATE TABLE rvl.slow_probe (id integer);--> statement-breakpoint
SELECT pg_sleep(30);
