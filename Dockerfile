# The hosted copy of HuggingFound: searches and browses the catalogue and
# shows what people say about each model, but runs nothing itself. Visitors
# download and try models with HuggingFound on their own computers.
FROM node:22-slim
WORKDIR /app

# The app has no runtime dependencies, so the source is all the image needs.
COPY package.json ./
COPY bin ./bin
COPY src ./src
COPY public ./public

ENV NODE_ENV=production \
    PORT=4188 \
    # Nothing runs here; the controls that install, download or chat are off.
    HUGGINGFOUND_HOSTED=1 \
    # The scan and what people say are kept on the mounted disk, so a
    # redeploy does not start from an empty catalogue.
    HUGGINGFOUND_HOME=/var/data

EXPOSE 4188

# Creating the folder keeps a first run working even without a disk attached.
CMD ["sh", "-c", "mkdir -p \"$HUGGINGFOUND_HOME\" && exec node bin/huggingfound.js --no-open"]
