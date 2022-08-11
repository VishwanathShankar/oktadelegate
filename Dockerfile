FROM node:10-alpine

COPY ./ ./

# Install the Project Dependencies like Express Framework
RUN npm install

# Tell that this image is going to Open a Port 
EXPOSE 80

# Default Command to launch the Application
CMD ["npm", "start"]

