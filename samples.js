// Built-in sample datasets. They are synthetic and generated on the fly by DuckDB with
// deterministic hash-based "randomness", so they cost nothing to download and are identical everywhere.
// Released under CC0 along with the rest of this file.
const U = (expr) => `((hash(${expr}) % 1000003)::DOUBLE / 1000003)`; // uniform [0,1)

const ZONES = [
  [1, 'Midtown Center', 'Manhattan'], [2, 'Upper East Side', 'Manhattan'], [3, 'Financial District', 'Manhattan'],
  [4, 'Harlem', 'Manhattan'], [5, 'Williamsburg', 'Brooklyn'], [6, 'Park Slope', 'Brooklyn'],
  [7, 'Astoria', 'Queens'], [8, 'JFK Airport', 'Queens'], [9, 'LaGuardia Airport', 'Queens'],
  [10, 'Fordham', 'Bronx'], [11, 'St. George', 'Staten Island'], [12, 'Chelsea', 'Manhattan'],
];
const FIRST = ['Ava', 'Liam', 'Mia', 'Noah', 'Zoe', 'Ethan', 'Isla', 'Arjun', 'Priya', 'Mateo', 'Sofia', 'Kenji', 'Amara', 'Lucas', 'Yara', 'Omar', 'Elena', 'Ravi', 'Chloe', 'Diego'];
const LAST = ['Smith', 'Garcia', 'Chen', 'Patel', 'Kim', 'Nguyen', 'Silva', 'Müller', 'Rossi', 'Okafor', 'Haddad', 'Novak', 'Reddy', 'Tanaka', 'Lopez', 'Brown'];
const CATS = ['Electronics', 'Home', 'Outdoors', 'Books', 'Toys', 'Beauty', 'Grocery', 'Sports'];
const list = (a) => '[' + a.map((s) => `'${s.replace(/'/g, "''")}'`).join(', ') + ']';

export const SAMPLES = [
  {
    name: 'taxi_zones', group: 'NYC-style taxi', description: '12 pickup/drop-off zones with their borough',
    sql: `CREATE OR REPLACE TABLE taxi_zones AS SELECT * FROM (VALUES ${ZONES.map(([id, z, b]) => `(${id}, '${z}', '${b}')`).join(', ')}) t(zone_id, zone, borough)`,
  },
  {
    name: 'taxi_trips', group: 'NYC-style taxi', description: '50,000 synthetic trips in January 2025',
    sql: `CREATE OR REPLACE TABLE taxi_trips AS
WITH base AS (
  SELECT i AS trip_id,
    TIMESTAMP '2025-01-01 00:00:00' + to_seconds((${U('i * 11 + 1')} * 31 * 86400)::BIGINT) AS pickup_at,
    1 + (hash(i * 11 + 2) % 12)::INT AS pickup_zone_id,
    1 + (hash(i * 11 + 3) % 12)::INT AS dropoff_zone_id,
    1 + CASE WHEN hash(i * 11 + 4) % 100 < 70 THEN 0 WHEN hash(i * 11 + 4) % 100 < 88 THEN 1 ELSE 1 + (hash(i * 11 + 5) % 5)::INT END AS passenger_count,
    round(0.4 + pow(${U('i * 11 + 6')}, 2) * 18, 2) AS trip_distance_mi,
    ${U('i * 11 + 7')} AS u_pay, ${U('i * 11 + 8')} AS u_tip,
    CASE WHEN hash(i * 11 + 9) % 2 = 0 THEN 'Yellow Cab Co' ELSE 'Metro Ride' END AS vendor
  FROM range(1, 50001) r(i)
)
SELECT trip_id, vendor, pickup_at,
  pickup_at + to_seconds((120 + trip_distance_mi * 150 + u_tip * 300)::BIGINT) AS dropoff_at,
  pickup_zone_id, dropoff_zone_id, passenger_count, trip_distance_mi,
  round(3.0 + trip_distance_mi * 2.5, 2) AS fare_amount,
  CASE WHEN u_pay < 0.68 THEN 'card' WHEN u_pay < 0.9 THEN 'cash' ELSE 'app' END AS payment_type,
  CASE WHEN u_pay < 0.68 OR u_pay >= 0.9 THEN round((3.0 + trip_distance_mi * 2.5) * (0.1 + u_tip * 0.15), 2) ELSE 0 END AS tip_amount
FROM base ORDER BY trip_id`,
  },
  {
    name: 'customers', group: 'Shop star schema', description: '2,000 customers (dimension)',
    sql: `CREATE OR REPLACE TABLE customers AS
SELECT i AS customer_id,
  ${list(FIRST)}[1 + (hash(i * 5 + 1) % ${FIRST.length})::INT] || ' ' || ${list(LAST)}[1 + (hash(i * 5 + 2) % ${LAST.length})::INT] AS full_name,
  'customer' || i || '@example.com' AS email,
  ['US', 'US', 'US', 'CA', 'GB', 'DE', 'IN', 'BR', 'JP', 'MX'][1 + (hash(i * 5 + 3) % 10)::INT] AS country,
  ['Consumer', 'Consumer', 'Small Business', 'Enterprise'][1 + (hash(i * 5 + 4) % 4)::INT] AS segment,
  DATE '2022-01-01' + (hash(i * 5 + 5) % 1000)::INT AS signup_date
FROM range(1, 2001) r(i)`,
  },
  {
    name: 'products', group: 'Shop star schema', description: '120 products (dimension)',
    sql: `CREATE OR REPLACE TABLE products AS
SELECT i AS product_id,
  ${list(CATS)}[1 + ((i - 1) % ${CATS.length})::INT] AS category,
  ${list(CATS)}[1 + ((i - 1) % ${CATS.length})::INT] || ' item #' || i AS product_name,
  round(4.99 + ${U('i * 3 + 1')} * 245, 2)::DECIMAL(10,2) AS unit_price
FROM range(1, 121) r(i)`,
  },
  {
    name: 'orders', group: 'Shop star schema', description: '20,000 orders in 2024 (fact header)',
    sql: `CREATE OR REPLACE TABLE orders AS
SELECT i AS order_id,
  1 + (hash(i * 7 + 1) % 2000)::INT AS customer_id,
  DATE '2024-01-01' + (hash(i * 7 + 2) % 366)::INT AS order_date,
  CASE WHEN hash(i * 7 + 3) % 100 < 88 THEN 'delivered' WHEN hash(i * 7 + 3) % 100 < 95 THEN 'shipped' WHEN hash(i * 7 + 3) % 100 < 98 THEN 'returned' ELSE 'cancelled' END AS status,
  ['web', 'web', 'mobile', 'mobile', 'store'][1 + (hash(i * 7 + 4) % 5)::INT] AS channel
FROM range(1, 20001) r(i)`,
  },
  {
    name: 'order_items', group: 'Shop star schema', description: '1–4 lines per order (fact lines)',
    sql: `CREATE OR REPLACE TABLE order_items AS
WITH lines AS (SELECT order_id, unnest(range(1, 2 + (hash(order_id * 13) % 4)::INT)) AS line_no FROM orders)
SELECT l.order_id, l.line_no::INT AS line_no,
  p.product_id, 1 + (hash(l.order_id * 17 + l.line_no) % 3)::INT AS quantity, p.unit_price,
  CASE WHEN hash(l.order_id * 19 + l.line_no) % 10 = 0 THEN 0.15 ELSE 0 END::DECIMAL(4,2) AS discount
FROM lines l JOIN products p ON p.product_id = 1 + (hash(l.order_id * 23 + l.line_no) % 120)::INT
ORDER BY l.order_id, l.line_no`,
  },
];

export const WELCOME_SQL = `-- Welcome to SQLPlayground: DuckDB running entirely in your browser.
-- Your files never leave this device. Press Ctrl/Cmd+Enter to run the statement under the cursor.

-- Busiest pickup zones in the sample taxi data
SELECT z.zone, z.borough, count(*) AS trips,
       round(avg(t.fare_amount + t.tip_amount), 2) AS avg_total,
       round(100.0 * count(*) FILTER (WHERE t.payment_type = 'card') / count(*), 1) AS pct_card
FROM taxi_trips t
JOIN taxi_zones z ON z.zone_id = t.pickup_zone_id
GROUP BY ALL
ORDER BY trips DESC;

-- Revenue by category and month (star schema)
SELECT date_trunc('month', o.order_date) AS month, p.category,
       sum(i.quantity * i.unit_price * (1 - i.discount)) AS revenue
FROM order_items i
JOIN orders o USING (order_id)
JOIN products p USING (product_id)
WHERE o.status <> 'cancelled'
GROUP BY ALL
ORDER BY month, revenue DESC;
`;

// Handy DuckDB snippets for data engineering work.
export const BUILTIN_SNIPPETS = [
  { name: 'Profile a table (SUMMARIZE)', sql: 'SUMMARIZE taxi_trips;' },
  { name: 'Describe a table', sql: 'DESCRIBE taxi_trips;' },
  { name: 'Deduplicate: latest row per key (QUALIFY)', sql: `SELECT *\nFROM orders\nQUALIFY row_number() OVER (PARTITION BY customer_id ORDER BY order_date DESC) = 1;` },
  { name: 'Running total (window)', sql: `SELECT order_date, count(*) AS orders,\n       sum(count(*)) OVER (ORDER BY order_date) AS running_orders\nFROM orders\nGROUP BY order_date\nORDER BY order_date;` },
  { name: 'PIVOT', sql: `PIVOT (SELECT channel, status FROM orders)\nON status\nUSING count(*)\nGROUP BY channel;` },
  { name: 'Null & distinct check per column', sql: `SELECT count(*) AS rows,\n       count(*) - count(customer_id) AS null_customer_id,\n       count(DISTINCT customer_id) AS distinct_customer_id\nFROM orders;` },
  { name: 'Find duplicate keys', sql: `SELECT order_id, line_no, count(*) AS n\nFROM order_items\nGROUP BY ALL\nHAVING count(*) > 1;` },
  { name: 'Referential integrity (orphans)', sql: `SELECT o.*\nFROM orders o\nANTI JOIN customers c USING (customer_id);` },
  { name: 'Hourly time series with gaps filled', sql: `WITH hours AS (\n  SELECT unnest(generate_series(TIMESTAMP '2025-01-01', TIMESTAMP '2025-01-07', INTERVAL 1 HOUR)) AS hour\n)\nSELECT h.hour, count(t.trip_id) AS trips\nFROM hours h\nLEFT JOIN taxi_trips t ON date_trunc('hour', t.pickup_at) = h.hour\nGROUP BY ALL ORDER BY h.hour;` },
  { name: 'ASOF join', sql: `-- match each trip to the most recent hourly bucket at or before pickup\nWITH buckets AS (SELECT unnest(generate_series(TIMESTAMP '2025-01-01', TIMESTAMP '2025-02-01', INTERVAL 1 HOUR)) AS ts)\nSELECT t.trip_id, t.pickup_at, b.ts AS bucket\nFROM taxi_trips t ASOF JOIN buckets b ON t.pickup_at >= b.ts\nLIMIT 20;` },
  { name: 'Read a remote Parquet file', sql: `-- the server must allow CORS\nSELECT * FROM read_parquet('https://example.com/data.parquet') LIMIT 100;` },
  { name: 'Unnest JSON / lists', sql: `SELECT j.id, unnest(j.tags) AS tag\nFROM (SELECT 1 AS id, ['a','b','c'] AS tags) j;` },
  { name: 'SCD2 change detection', sql: `-- compare two snapshots by key and flag inserts / updates / deletes\nWITH old AS (SELECT * FROM customers WHERE customer_id <= 1500),\n     new AS (SELECT * REPLACE (CASE WHEN customer_id % 50 = 0 THEN 'Enterprise' ELSE segment END AS segment) FROM customers WHERE customer_id > 10)\nSELECT coalesce(n.customer_id, o.customer_id) AS customer_id,\n       CASE WHEN o.customer_id IS NULL THEN 'insert' WHEN n.customer_id IS NULL THEN 'delete' ELSE 'update' END AS change\nFROM old o FULL JOIN new n USING (customer_id)\nWHERE o.customer_id IS NULL OR n.customer_id IS NULL OR o.segment IS DISTINCT FROM n.segment\nORDER BY 1;` },
];
