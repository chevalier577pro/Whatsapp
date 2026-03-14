FROM node:20-slim

RUN apt-get update && apt-get install -y git openssh-client --no-install-recommends && rm -rf /var/lib/apt/lists/*

RUN git config --global url."https://".insteadOf ssh://

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

CMD ["node", "index.js"]
