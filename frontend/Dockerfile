FROM nginx:alpine
COPY index.html /usr/share/nginx/html/index.html
COPY xlsx.full.min.js /usr/share/nginx/html/xlsx.full.min.js
COPY jspdf.umd.min.js /usr/share/nginx/html/jspdf.umd.min.js
COPY pdf.min.js /usr/share/nginx/html/pdf.min.js
COPY pdf.worker.min.js /usr/share/nginx/html/pdf.worker.min.js
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
