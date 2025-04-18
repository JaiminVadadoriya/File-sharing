# Use a more secure, recent base image
FROM node:23-slim

# Install system dependencies for wrtc and node-gyp, and clean up to reduce image size
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Set a non-root user (for added security)
RUN useradd -m nodeuser

# Set the working directory to /usr/src/app
WORKDIR /usr/src/app

# Copy package.json and package-lock.json
COPY package*.json ./

# Create uploads dir and set correct permissions
RUN mkdir -p /usr/src/app/uploads && chown -R nodeuser:nodeuser /usr/src/app


# Install npm dependencies (omitting dev dependencies in production)
RUN npm install && npm prune --omit=dev

# Copy the rest of the app's code
COPY . .


# Accept build-time argument for environment
ENV PORT=3000
ARG DOCKER_ENV
ENV NODE_ENV=${DOCKER_ENV}

# Conditional message during the build
RUN if [ "$DOCKER_ENV" = "stag" ] ; then \
    echo "Your NODE_ENV for stage is $NODE_ENV"; \
    else echo "Your NODE_ENV for dev is $NODE_ENV"; \
    fi 

EXPOSE ${PORT}

# Switch to the non-root user
USER nodeuser

# Run the application
CMD [ "npm", "run", "start" ]
