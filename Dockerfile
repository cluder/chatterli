# Wir nutzen ein leichtgewichtiges Node Image
FROM node:20-alpine

# Arbeitsverzeichnis im Container
WORKDIR /app

# Abhängigkeiten installieren
COPY package.json ./
RUN npm install --production

# Quellcode kopieren
COPY server.js ./
COPY public ./public

# Port freigeben (Cloud Run nutzt meist 8080)
EXPOSE 8080

# Server starten
CMD ["npm", "start"]