start:
	$(info Make: Starting containers.)
	@docker compose up -d

stop:
	$(info Make: Stopping containers.)
	@docker compose stop

restart:
	$(info Make: Restarting containers.)
	@docker compose restart

clean:
	@docker system prune --volumes --force

migration-generate:
	yarn run build
	npx typeorm migration:generate -n $(filter-out $@,$(MAKECMDGOALS))

migration-run:
	yarn run build
	npx typeorm migration:run
