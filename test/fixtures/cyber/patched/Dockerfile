FROM node:18.20.4-alpine
WORKDIR /app
COPY server.js ./
RUN addgroup --system app && adduser --system --ingroup app app
USER app
EXPOSE 3000
CMD ["node", "server.js"]
