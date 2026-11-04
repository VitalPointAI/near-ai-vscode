FROM node:latest
WORKDIR /app
COPY server.js ./
ENV API_KEY=fixture-secret-DO-NOT-USE.invalid
USER root
EXPOSE 3000
CMD ["node", "server.js"]
