# Medplum 5.2.4 on Render.
#
# The upstream image expects a configuration file (or a config source argument). The wrapper
# translates Render's DATABASE_URL / REDIS_URL / PORT variables into Medplum's MEDPLUM_* settings
# and starts the unmodified server with the `env` config source.
FROM medplum/medplum-server:5.2.4

# Render mounts the persistent disk as root; the hardened upstream image runs as a non-root user.
# This image only writes to /data (binary storage) and to stdout.
USER root

COPY start-medplum.mjs /usr/local/bin/start-medplum.mjs

EXPOSE 10000
ENTRYPOINT ["node", "/usr/local/bin/start-medplum.mjs"]
