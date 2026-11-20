CREATE TABLE rvl.slow_probe (id integer);--> statement-breakpoint
-- 5s: đủ dài để kill -9 rơi vào giữa sleep (poll 300ms bắt được), đủ ngắn để
-- zombie backend chết deterministic trong poll window — backend chỉ hết sống
-- khi sleep xong và ghi xuống socket chết → abort + rollback (§3a.5).
SELECT pg_sleep(5);
