# SARKI Data House

SARKI is a Node.js app for data bundle browsing, account sign-in, and wallet access.
Account data is stored in MySQL so the app can use a MySQL service from Replit or
another Node.js host.

## MySQL setup

1. Create a MySQL database and a database user with permission to create and read
   tables in that database.
2. Import `database/schema.sql` into that database using the host's MySQL tool,
   such as phpMyAdmin or its database console.
3. Set the database connection in the app's environment:
   - Use `DATABASE_URL` or `MYSQL_URL`, for example
     `mysql://username:password@db.example.com:3306/sarki_data_house`; or
   - Set `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, and
     `MYSQL_DATABASE` separately. Set `MYSQL_SSL=true` when the database host
     requires verified TLS.
4. Start the app with `pnpm start` (or `pnpm run dev` while developing).

For a hosting provider such as Hosting.com, enter the same environment settings
in its Node.js app settings and import the schema into the MySQL database supplied
by the host. Do not commit real database passwords to this project.

The landing page works without a database connection, but sign-up, login, and
wallet sessions require the MySQL settings and schema above.

## MTN data sales

The data provider is Bilalsadasub. The app offers MTN 1 GB for ₦450
(network ID `1`, plan ID `263`) and MTN 2 GB for ₦800 (network ID `1`, plan ID
`3`). These are 30-day SME plans. The provider's current listed costs are ₦400
and ₦760 respectively; verify the public catalog before changing these plan IDs
or retail prices.

Server-side purchases use `https://bilalsadasub.com/api/data` and the
`BILALSADASUB_API_TOKEN` secret. Never commit the AccessToken or put it in
browser code. Each provider request includes a unique `request-id`; the app
records provider status and a sanitized provider message in `sarki_data_orders`.
The wallet debit is atomic with order creation. A provider `fail` response
refunds the SARKI wallet; `process`, timeouts, and ambiguous responses hold the
debit and block duplicate orders.

If the existing MySQL database already has `sarki_data_orders`, add the
`provider_message` column from `database/schema.sql` before restarting the app.
New databases receive the full schema from that file.

Wallet top-ups are not implemented yet. Customers need a separately managed
wallet balance of at least ₦450 or ₦800, depending on their selected bundle.
The purchase form asks whether the destination number has been ported to MTN;
that setting maps to Bilalsadasub's `bypass` flag.

## Sessions

After login, the app opens directly to the wallet. The wallet has no Home or Log
out button. The login cookie is a browser-session cookie with no fixed 30-day
expiry, and its database session has no expiration date. Clearing the
`sarki_session` cookie in the browser removes access to that session.
