FROM node:20.9-bullseye-slim

WORKDIR /root

COPY package.json .
COPY package-lock.json .
RUN npm ci

COPY jinaga-server/ jinaga-server/
COPY jinaga.test.js .
COPY specification.test.js .

ENTRYPOINT [ "npm", "test" ]