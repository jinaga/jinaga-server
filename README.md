# Jinaga Server

Application-agnostic back end for web applications.

Run a Jinaga server in Node to create your own custom Jinaga Replicator.
Serve up or point a Jinaga client at this server to expose the data to the user.
Updates from the application are automatically sent to the server.
Changes needed in the application are automatically fetched from the server.

## Install

Install Jinaga Server from the NPM package.

```bash
npm i jinaga-server
```

See [jinaga.com](https://jinaga.com) for details on how to use this package.

## Running a Database in a Docker Container

The Jinaga server stores its data in a PostgreSQL database.
The easiest way to get a database up and running is to start a Docker container.

```bash
docker run --name jinaga-postgres -p5432:5432 -e POSTGRES_PASSWORD=secretpw -e APP_USERNAME=appuser -e APP_PASSWORD=apppw -e APP_DATABASE=appdb jinaga/jinaga-postgres-fact-keystore
```

## Installing a Database

If you are running Postgres yourself, you can create a Jinaga database on your server.
The setup script is written for Linux.
To run the script, make sure you have the `psql` command [installed](https://www.postgresql.org/download/).
To check, run:

```bash
psql --version
```

If you don't have `psql` installed, install it:

```bash
sudo sh -c 'echo "deb http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list'
wget --quiet -O - https://www.postgresql.org/media/keys/ACCC4CF8.asc | sudo apt-key add -
sudo apt-get update
sudo apt-get install postgresql-client
```

Then run the setup script.
To create a new database, you will need to know the following information about your PostgreSQL installation:

- Host name
- Port (probably 5432)
- Admin user name (probably postgres)
- Admin database name (also probably postgres)
- Admin password

Then you will need to decide on the following:

- Application user name
- Application database name
- Application password

Once you have those values, set some environment variables and run the script:

```bash
export JINAGA_POSTGRES_HOST="localhost"
export JINAGA_POSTGRES_PORT="5432"
export JINAGA_POSTGRES_ADMIN_USER="postgres"
export JINAGA_POSTGRES_ADMIN_DATABASE="postgres"
export JINAGA_POSTGRES_ADMIN_PASSWORD="$ecr3t"
export JINAGA_POSTGRES_APP_USER="appuser"
export JINAGA_POSTGRES_APP_DATABASE="appdb"
export JINAGA_POSTGRES_APP_PASSWORD="apppw"

./setup.sh
```

Or if you are running from the installed package, run the script from `node_modules`:

```bash
./node_modules/jinaga-server/setup.sh
```

## Configuring the connection pool

When you give Jinaga server a connection string, it builds the connection pool
for you, and these environment variables set it up. Each one defaults to the
value below when it is unset or empty, so a deployment that sets none of them
behaves exactly as it did before they existed.

| Variable | Units | Default | Meaning |
| --- | --- | --- | --- |
| `POSTGRES_POOL_MAX` | connections | `10` | The most connections the pool will open. Must be at least 1. |
| `POSTGRES_IDLE_TIMEOUT_MILLIS` | milliseconds | `30000` | How long an idle connection stays in the pool before it is closed. `0` keeps idle connections forever. |
| `POSTGRES_CONNECTION_TIMEOUT_MILLIS` | milliseconds | `0` | How long a query waits for a connection to come free before it fails. `0` waits forever. |

Each must be a whole number of its own unit. A value that is not makes
`JinagaServer.create` throw, naming the variable and the value it received,
rather than starting a server configured with something nobody chose.

These variables apply only to a pool that Jinaga server builds from a
connection string. If you pass your own `pg` `Pool` as `pgStore` or
`pgKeystore`, it is used exactly as you configured it.

## Setting the log level

`LOG_LEVEL` sets how much Jinaga server logs. It takes one of `debug`, `info`,
`warn` or `error`, in lowercase, and each level includes the ones after it.
`debug` adds per-item detail, such as one line per listener notified, which is
useful during an incident and too much for every day.

When `LOG_LEVEL` is unset or empty, the level is left as it was: `info`, unless
your own code called `Trace.setLevel` before `JinagaServer.create`. Any other
value makes `JinagaServer.create` throw, naming the value it received and the
accepted ones, so a misspelled level stops the server from starting rather
than being ignored.

`LOG_LEVEL` governs output that goes through Jinaga's `Trace`. Some of the
server's own HTTP streaming messages are still written directly to the console,
and are not affected by it.

## Migrating from version 2

If you are already running a Jinaga database, whether in a container or on your own PostgreSQL server, you will need to upgrade to get it to work with version 3.
The Jinaga server version 2 used a less efficient database schema.
Run the setup script as described above to upgrade the database schema.

Your data is moved to a new Postgres schema called `legacy`.
It is not modified during the process.
Nevertheless, it would be wise to back up your database before running this operation.

## Build

To build Jinaga server, you will need Node 16.

```bash
npm ci
npm run build
npm test
```


## Debugging - Walking through the code
- Adapt the database connection string in src/debug.ts
- Build the code using the instructions above.
- Set breakpoints in the typescript source code.
- Open a "Javascript Debug Terminal" in VSCode and execute:
```bash
npm run debug
```
- Use Postman to "post" facts to http://localhost:8080/jinaga/write or to "post" specifications to  http://localhost:8080/jinaga/read .   
- The debugger will break when it reaches a breakpoint.

## Release

To release a new version of Jinaga server, bump the version number, create a new release
from the generated tag, and let GitHub Actions do the rest.

```bash
git c main
git pull
npm version patch
git push --follow-tags
gh release create v$(node -p "require('./package.json').version") --generate-notes --verify-tag
```
