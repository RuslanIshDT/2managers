server_tokens off;
absolute_redirect off;
resolver 127.0.0.11 valid=10s ipv6=off;

location / {
  set $upstream http://app:3000;
  proxy_pass $upstream;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Host $host;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_read_timeout 120s;
}
