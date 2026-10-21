CREATE TABLE IF NOT EXISTS sarki_users (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    phone_e164 VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    password_salt BINARY(16) NOT NULL,
    password_hash BINARY(64) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_sarki_users_phone_e164 (phone_e164)
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sarki_wallets (
    user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    balance_kobo BIGINT UNSIGNED NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id),
    CONSTRAINT fk_sarki_wallets_user
        FOREIGN KEY (user_id) REFERENCES sarki_users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sarki_sessions (
    token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    expires_at DATETIME NULL DEFAULT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (token_hash),
    KEY idx_sarki_sessions_user_id (user_id),
    CONSTRAINT fk_sarki_sessions_user
        FOREIGN KEY (user_id) REFERENCES sarki_users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sarki_data_orders (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    idempotency_key CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    recipient_phone_e164 VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    network_id INT UNSIGNED NOT NULL,
    plan_id INT UNSIGNED NOT NULL,
    amount_kobo BIGINT UNSIGNED NOT NULL,
    ported_number TINYINT(1) NOT NULL,
    status ENUM('processing', 'pending', 'submitted', 'successful', 'failed') NOT NULL DEFAULT 'processing',
    provider_reference VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
    provider_message VARCHAR(255) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_sarki_data_orders_user_idempotency (user_id, idempotency_key),
    KEY idx_sarki_data_orders_user_created_at (user_id, created_at),
    KEY idx_sarki_data_orders_status_created_at (status, created_at),
    CONSTRAINT fk_sarki_data_orders_user
        FOREIGN KEY (user_id) REFERENCES sarki_users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
