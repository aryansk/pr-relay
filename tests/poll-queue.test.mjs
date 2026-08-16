@@
-test("five valid Pending jobs are processed", async () => {
-  const records = Array.from({ length: 5 }, (_, index) => airtableRecord({
-    recordNumber: index + 1,
-    id: `job-${index + 1}`,
-    job: {
-      branch: `fix/batch-${index + 1}`,
-      upstreamIssue: 2000 + index,
-      prBody: `Fixes #${2000 + index}`,
-    },
-    createdTime: `2026-08-16T00:0${index}:00.000Z`,
-  }));
-  const { promise, client, airtable } = runPoll(records);
-  const result = await promise;
-
-  assert.deepEqual(result.created, ["job-1", "job-2", "job-3", "job-4", "job-5"]);
-  assert.equal(client.created.length, 5);
-  assert.equal(airtable.statuses.length, 5);
-});
+test("50 valid Pending jobs are processed", async () => {
+  const count = 50;
+  const records = Array.from({ length: count }, (_, index) => airtableRecord({
+    recordNumber: index + 1,
+    id: `job-${index + 1}`,
+    job: {
+      branch: `fix/batch-${index + 1}`,
+      upstreamIssue: 2000 + index,
+      prBody: `Fixes #${2000 + index}`,
+    },
+    createdTime: `2026-08-16T00:${String(index).padStart(2, "0")}:00.000Z`,
+  }));
+  const { promise, client, airtable } = runPoll(records);
+  const result = await promise;
+
+  const expectedCreated = Array.from({ length: count }, (_, i) => `job-${i + 1}`);
+  assert.deepEqual(result.created, expectedCreated);
+  assert.equal(client.created.length, count);
+  assert.equal(airtable.statuses.length, count);
+});
@@
-test("more than five Pending jobs processes the oldest five", async () => {
-  const records = Array.from({ length: 7 }, (_, index) => airtableRecord({
-    recordNumber: index + 1,
-    id: `job-${index + 1}`,
-    job: {
-      branch: `fix/oldest-${index + 1}`,
-      upstreamIssue: 2100 + index,
-      prBody: `Fixes #${2100 + index}`,
-    },
-    createdTime: `2026-08-16T00:0${index}:00.000Z`,
-  })).reverse();
-  const { promise, client, airtable } = runPoll(records);
-  const result = await promise;
-
-  assert.equal(MAX_QUEUE_JOBS, 5);
-  assert.deepEqual(result.created, ["job-1", "job-2", "job-3", "job-4", "job-5"]);
-  assert.deepEqual(airtable.statuses.map((item) => item.recordId), records.slice(2).reverse().map((item) => item.id));
-  assert.equal(client.created.length, 5);
-});
+test("more than fifty Pending jobs processes the oldest fifty", async () => {
+  const total = 52;
+  const records = Array.from({ length: total }, (_, index) => airtableRecord({
+    recordNumber: index + 1,
+    id: `job-${index + 1}`,
+    job: {
+      branch: `fix/oldest-${index + 1}`,
+      upstreamIssue: 2100 + index,
+      prBody: `Fixes #${2100 + index}`,
+    },
+    createdTime: `2026-08-16T00:${String(index).padStart(2, "0")}:00.000Z`,
+  })).reverse();
+  const { promise, client, airtable } = runPoll(records);
+  const result = await promise;
+
+  assert.equal(MAX_QUEUE_JOBS, 50);
+  const expectedCreated = Array.from({ length: 50 }, (_, i) => `job-${i + 1}`);
+  assert.deepEqual(result.created, expectedCreated);
+
+  const processedRecordIds = records.slice(total - 50).reverse().map((item) => item.id);
+  assert.deepEqual(airtable.statuses.map((item) => item.recordId), processedRecordIds);
+  assert.equal(client.created.length, 50);
+});
