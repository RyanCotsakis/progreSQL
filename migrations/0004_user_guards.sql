CREATE TRIGGER users_keep_last_admin_update BEFORE UPDATE OF is_admin ON users
WHEN OLD.is_admin=1 AND NEW.is_admin=0 AND (SELECT COUNT(*) FROM users WHERE is_admin=1)=1
BEGIN SELECT RAISE(ABORT,'Keep at least one admin.'); END;
CREATE TRIGGER users_keep_last_admin_delete BEFORE DELETE ON users
WHEN OLD.is_admin=1 AND (SELECT COUNT(*) FROM users WHERE is_admin=1)=1
BEGIN SELECT RAISE(ABORT,'Keep at least one admin.'); END;
CREATE TRIGGER exercise_owner_immutable BEFORE UPDATE OF user_id ON exercise
WHEN OLD.user_id<>NEW.user_id BEGIN SELECT RAISE(ABORT,'Record ownership cannot be changed.'); END;
CREATE TRIGGER workout_owner_immutable BEFORE UPDATE OF user_id ON workout
WHEN OLD.user_id<>NEW.user_id BEGIN SELECT RAISE(ABORT,'Record ownership cannot be changed.'); END;
CREATE TRIGGER settings_owner_immutable BEFORE UPDATE OF user_id ON exercise_settings_history
WHEN OLD.user_id<>NEW.user_id BEGIN SELECT RAISE(ABORT,'Record ownership cannot be changed.'); END;
CREATE TRIGGER membership_owner_immutable BEFORE UPDATE OF user_id ON workout_exercise
WHEN OLD.user_id<>NEW.user_id BEGIN SELECT RAISE(ABORT,'Record ownership cannot be changed.'); END;
CREATE TRIGGER session_owner_immutable BEFORE UPDATE OF user_id ON workout_session
WHEN OLD.user_id<>NEW.user_id BEGIN SELECT RAISE(ABORT,'Record ownership cannot be changed.'); END;
