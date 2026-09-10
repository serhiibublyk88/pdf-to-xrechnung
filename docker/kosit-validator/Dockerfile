FROM alpine:3.24 AS fetch

ARG VALIDATOR_VERSION=1.6.1
ARG CONFIG_TAG=v2026-01-31
ARG CONFIG_FILE=xrechnung-3.0.2-validator-configuration-2026-01-31.zip

# Checksums pin verified bytes because tags and release assets can change.
ARG VALIDATOR_SHA256=6421704675af694a9751f445cfe2fa2ea41dd6eb34939a5da261880133b1f7cd
ARG CONFIG_SHA256=6a5a5911a421b25fbc423f62f93f894df7b236f5d73ca4f84bb222a945082704

RUN apk add --no-cache curl unzip

WORKDIR /fetch

RUN curl -fsSL -o validator.jar \
      "https://github.com/itplr-kosit/validator/releases/download/v${VALIDATOR_VERSION}/validator-${VALIDATOR_VERSION}-standalone.jar" \
 && echo "${VALIDATOR_SHA256}  validator.jar" | sha256sum -c - \
 && curl -fsSL -o config.zip \
      "https://github.com/itplr-kosit/validator-configuration-xrechnung/releases/download/${CONFIG_TAG}/${CONFIG_FILE}" \
 && echo "${CONFIG_SHA256}  config.zip" | sha256sum -c - \
 && unzip -q config.zip -d config \
 && rm config.zip

FROM eclipse-temurin:21-jre-jammy

LABEL org.opencontainers.image.description="KoSIT XRechnung validator, pinned to checksummed upstream artifacts"

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --create-home --shell /usr/sbin/nologin validator

WORKDIR /app

COPY --from=fetch /fetch/validator.jar ./validator.jar
COPY --from=fetch /fetch/config/ ./

RUN chown -R validator:validator /app
USER validator

EXPOSE 8081

# The daemon only accepts POST validation requests, so any 4xx response still proves it is up.
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=6 \
  CMD curl -fsS -o /dev/null -w '%{http_code}' http://127.0.0.1:8081/ | grep -qE '^(200|4[0-9]{2})$' || exit 1

ENTRYPOINT ["java", "-Xms256m", "-Xmx1g", "-XX:+UseG1GC", "-XX:+ExitOnOutOfMemoryError", \
  "-jar", "validator.jar", "-s", "scenarios.xml", "-D", "-H", "0.0.0.0", "-P", "8081", "--disable-gui"]
