package dev.tokenbeacon.display;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;

import java.nio.charset.StandardCharsets;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.Signature;
import java.security.cert.Certificate;
import java.security.spec.ECGenParameterSpec;

/**
 * The display's identity: an ECDSA P-256 key pair in the Android Keystore.
 * The private key never leaves the Keystore. TokenBeacon remembers the public
 * key when it pairs and, on every connection, asks the phone to sign a fresh
 * challenge (src/device/ble-trust.ts). The display ID shown in the app is the
 * first 16 hex digits of SHA-256 over the public key.
 */
final class Identity {
    private static final String ALIAS = "tokenbeacon-display-identity";
    static final byte[] AUTH_CONTEXT = "tokenbeacon-ble-auth/v1\n".getBytes(StandardCharsets.UTF_8);
    static final int CHALLENGE_BYTES = 32;

    private final PrivateKey privateKey;
    private final byte[] publicKey;
    private final String id;

    private Identity(PrivateKey privateKey, PublicKey publicKey) throws Exception {
        this.privateKey = privateKey;
        this.publicKey = publicKey.getEncoded(); // X.509 SubjectPublicKeyInfo (DER)
        this.id = displayId(this.publicKey);
    }

    static Identity load() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (!store.containsAlias(ALIAS)) {
            KeyPairGenerator generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore");
            generator.initialize(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
                    .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1"))
                    .setDigests(KeyProperties.DIGEST_SHA256)
                    .build());
            generator.generateKeyPair();
        }
        PrivateKey privateKey = (PrivateKey) store.getKey(ALIAS, null);
        Certificate certificate = store.getCertificate(ALIAS);
        return new Identity(privateKey, certificate.getPublicKey());
    }

    String id() {
        return id;
    }

    /** "1a2b 3c4d 5e6f 7a8b" for reading aloud or typing into TOKENBEACON_DEVICE_ID. */
    String displayText() {
        return id.substring(0, 4) + " " + id.substring(4, 8) + " " + id.substring(8, 12) + " " + id.substring(12, 16);
    }

    /** [u16 key length][public key DER][ECDSA-SHA256 signature DER over AUTH_CONTEXT + challenge], or null. */
    byte[] answer(byte[] challenge) {
        if (challenge == null || challenge.length != CHALLENGE_BYTES) return null;
        try {
            Signature signature = Signature.getInstance("SHA256withECDSA");
            signature.initSign(privateKey);
            signature.update(AUTH_CONTEXT);
            signature.update(challenge);
            byte[] signed = signature.sign();
            byte[] out = new byte[2 + publicKey.length + signed.length];
            out[0] = (byte) (publicKey.length >> 8);
            out[1] = (byte) publicKey.length;
            System.arraycopy(publicKey, 0, out, 2, publicKey.length);
            System.arraycopy(signed, 0, out, 2 + publicKey.length, signed.length);
            return out;
        } catch (Exception e) {
            return null;
        }
    }

    static String displayId(byte[] publicKey) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(publicKey);
        StringBuilder hex = new StringBuilder();
        for (int i = 0; i < 8; i++) hex.append(String.format("%02x", digest[i] & 0xff));
        return hex.toString();
    }
}
