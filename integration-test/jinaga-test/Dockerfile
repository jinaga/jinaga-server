FROM node:22.12.0-alpine3.19

WORKDIR /root

COPY package.json .
COPY package-lock.json .
RUN npm ci

COPY jinaga-server/ jinaga-server/
COPY *.js .

ENTRYPOINT [ "npm", "test" ]
